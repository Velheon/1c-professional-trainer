-- Stage 3 preparation. Apply only to a personal Supabase project.
begin;
create table public.app_members (
  user_id uuid primary key references auth.users(id),
  created_at timestamptz not null default now()
);
alter table public.app_members enable row level security;
revoke all on public.app_members from public, anon, authenticated;
grant select on public.app_members to authenticated;
create policy read_own_membership on public.app_members for select to authenticated
  using ((select auth.uid()) = user_id);

create table public.sections (
  section_id uuid primary key, section_order integer not null unique check(section_order>0),
  section_code integer not null, section_title text not null
);
create table public.questions (
  question_id uuid primary key, section_id uuid not null references public.sections,
  question_order integer not null check(question_order>0), question_code integer not null,
  text text not null, explanation text not null, explanation_url text not null,
  keep_answer_order boolean not null, source_updated_at text not null,
  source_metadata jsonb not null default '{}',
  unique(section_id, question_order)
);
create table public.answers (
  answer_id uuid primary key, question_id uuid not null references public.questions,
  answer_order integer not null check(answer_order>0), answer_code integer not null,
  text text not null, is_correct boolean not null,
  unique(question_id, answer_id), unique(question_id, answer_order)
);
create unique index one_correct_answer on public.answers(question_id) where is_correct;
create table public.question_images (
  question_id uuid not null references public.questions, frame_order integer not null check(frame_order>0),
  storage_path text not null unique, sha256 text not null, width integer not null, height integer not null,
  primary key(question_id, frame_order)
);
create table public.bank_imports (
  sha256 text primary key, format_version integer not null, imported_at timestamptz not null default now(),
  report jsonb not null
);
-- A private allowlist, never an unrestricted authenticated policy.
do $$ declare tbl text; begin
  foreach tbl in array array['sections','questions','answers','question_images','bank_imports'] loop
    execute format('alter table public.%I enable row level security',tbl);
    execute format('revoke all on public.%I from public, anon, authenticated',tbl);
    execute format('grant select on public.%I to authenticated',tbl);
    execute format('create policy bank_member_read on public.%I for select to authenticated using (exists (select 1 from public.app_members where user_id=(select auth.uid())))',tbl);
  end loop;
end $$;
create table public.study_sessions (
  user_id uuid not null references auth.users, session_id uuid not null,
  version bigint not null check(version>0), device_id uuid not null,
  updated_at timestamptz not null, payload jsonb not null,
  primary key(user_id,session_id)
);
create table public.attempts (
  attempt_id uuid primary key, user_id uuid not null references auth.users,
  question_id uuid not null, answer_id uuid not null,
  is_correct boolean not null, is_unsure boolean not null,
  answered_at timestamptz not null, mode text not null check(mode in ('sequential','random','review','exam')),
  session_id uuid not null, device_id uuid not null,
  foreign key(question_id,answer_id) references public.answers(question_id,answer_id),
  unique(user_id,attempt_id)
);
create index attempts_user_time on public.attempts(user_id,answered_at,attempt_id);
create table public.attempt_annotations (
  event_id uuid primary key, user_id uuid not null references auth.users,
  attempt_id uuid not null, is_unsure boolean not null, changed_at timestamptz not null, device_id uuid not null,
  foreign key(user_id,attempt_id) references public.attempts(user_id,attempt_id)
);
create table public.user_question_flags (
  user_id uuid not null references auth.users, question_id uuid not null references public.questions,
  bookmarked boolean not null, skipped boolean not null, updated_at timestamptz not null,
  primary key(user_id,question_id)
);
create table public.user_preferences (
  user_id uuid primary key references auth.users, version bigint not null,
  updated_at timestamptz not null, payload jsonb not null
);
-- Mutable state is distinct from immutable attempt history.
do $$ declare tbl text; begin
  foreach tbl in array array['study_sessions','user_question_flags','user_preferences'] loop
    execute format('alter table public.%I enable row level security',tbl);
    execute format('revoke all on public.%I from public, anon, authenticated',tbl);
    execute format('grant select, insert, update on public.%I to authenticated',tbl);
    execute format('create policy own_select on public.%I for select to authenticated using ((select auth.uid())=user_id)',tbl);
    execute format('create policy own_insert on public.%I for insert to authenticated with check ((select auth.uid())=user_id and exists (select 1 from public.app_members where user_id=(select auth.uid())))',tbl);
    execute format('create policy own_update on public.%I for update to authenticated using ((select auth.uid())=user_id) with check ((select auth.uid())=user_id)',tbl);
  end loop;
  foreach tbl in array array['attempts','attempt_annotations'] loop
    execute format('alter table public.%I enable row level security',tbl);
    execute format('revoke all on public.%I from public, anon, authenticated',tbl);
    execute format('grant select, insert on public.%I to authenticated',tbl);
    execute format('create policy own_select on public.%I for select to authenticated using ((select auth.uid())=user_id)',tbl);
    execute format('create policy own_insert on public.%I for insert to authenticated with check ((select auth.uid())=user_id and exists (select 1 from public.app_members where user_id=(select auth.uid())))',tbl);
  end loop;
end $$;

create function public.check_attempt_key() returns trigger language plpgsql
set search_path = '' as $$ begin
  if not exists(select 1 from public.answers where answer_id=new.answer_id and question_id=new.question_id and is_correct=new.is_correct) then
    raise exception 'Answer key does not match the bank';
  end if;
  return new;
end $$;
revoke all on function public.check_attempt_key() from public, anon, authenticated;
create trigger enforce_attempt_key before insert on public.attempts for each row execute function public.check_attempt_key();

-- Compare-and-swap: stale versions never silently overwrite a newer session.
create function public.save_study_session(p_session_id uuid, p_expected_version bigint, p_device_id uuid, p_updated_at timestamptz, p_payload jsonb)
returns bigint language plpgsql security invoker set search_path = '' as $$
declare next_version bigint; begin
  if p_expected_version < 0 then raise exception 'Invalid version'; end if;
  if p_expected_version = 0 then
    insert into public.study_sessions(user_id,session_id,version,device_id,updated_at,payload)
      values(auth.uid(),p_session_id,1,p_device_id,p_updated_at,p_payload)
      on conflict(user_id,session_id) do nothing returning version into next_version;
  else
    update public.study_sessions set version=version+1,device_id=p_device_id,updated_at=p_updated_at,payload=p_payload
      where user_id=(select auth.uid()) and session_id=p_session_id and version=p_expected_version
      returning version into next_version;
  end if;
  if next_version is null then raise exception 'SESSION_CONFLICT'; end if;
  return next_version;
end $$;
revoke all on function public.save_study_session(uuid,bigint,uuid,timestamptz,jsonb) from public, anon;
grant execute on function public.save_study_session(uuid,bigint,uuid,timestamptz,jsonb) to authenticated;
-- Direct UPDATE would bypass the CAS function: only RPC may update sessions.
-- An invoker RPC needs UPDATE grants; enforce version increments with a trigger.
create function public.check_session_version() returns trigger language plpgsql set search_path = '' as $$ begin
  if new.version <> old.version+1 then raise exception 'SESSION_CONFLICT'; end if;
  return new;
end $$;
revoke all on function public.check_session_version() from public, anon, authenticated;
create trigger session_version_guard before update on public.study_sessions for each row execute function public.check_session_version();

insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
  values('question-images','question-images',false,10485760,array['image/png'])
  on conflict(id) do update set public=false,file_size_limit=excluded.file_size_limit,allowed_mime_types=excluded.allowed_mime_types;
-- Supabase owns storage.objects and manages its grants; add no public upload policy.
create policy trainer_private_images on storage.objects for select to authenticated
  using(bucket_id='question-images' and exists(select 1 from public.app_members where user_id=(select auth.uid())));
commit;
