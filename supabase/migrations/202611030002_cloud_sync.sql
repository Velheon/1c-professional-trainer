begin;
create table public.bank_source (
  bank_id integer primary key check(bank_id=1), source jsonb not null, report jsonb not null
);
alter table public.bank_source enable row level security;
revoke all on public.bank_source from public,anon,authenticated;
grant select on public.bank_source to authenticated;
create policy member_bank_source on public.bank_source for select to authenticated
  using(exists(select 1 from public.app_members where user_id=(select auth.uid())));

-- Versioned mutable state; immutable history stays in attempts/attempt_annotations.
create table public.user_sync_state (
  user_id uuid not null references auth.users, kind text not null check(kind in ('session','flag','preferences','active')),
  entity_id text not null, version bigint not null check(version>0), event_id uuid not null,
  payload jsonb not null, updated_at timestamptz not null default now(), primary key(user_id,kind,entity_id)
);
alter table public.user_sync_state enable row level security;
revoke all on public.user_sync_state from public,anon,authenticated;
grant select,insert,update on public.user_sync_state to authenticated;
create policy sync_own_read on public.user_sync_state for select to authenticated using(user_id=(select auth.uid()));
create policy sync_own_insert on public.user_sync_state for insert to authenticated with check(user_id=(select auth.uid()) and exists(select 1 from public.app_members where user_id=(select auth.uid())));
create policy sync_own_update on public.user_sync_state for update to authenticated using(user_id=(select auth.uid())) with check(user_id=(select auth.uid()) and exists(select 1 from public.app_members where user_id=(select auth.uid())));
create trigger sync_version_guard before update on public.user_sync_state for each row execute function public.check_session_version();
create function public.save_sync_state(p_kind text,p_entity_id text,p_expected_version bigint,p_event_id uuid,p_payload jsonb)
returns bigint language plpgsql security invoker set search_path='' as $$
declare result bigint; begin
  if p_expected_version<0 then raise exception 'Invalid version'; end if;
  if p_expected_version=0 then
    insert into public.user_sync_state(user_id,kind,entity_id,version,event_id,payload)
      values(auth.uid(),p_kind,p_entity_id,1,p_event_id,p_payload)
      on conflict(user_id,kind,entity_id) do nothing returning version into result;
  else
    update public.user_sync_state set version=version+1,event_id=p_event_id,payload=p_payload,updated_at=now()
      where user_id=auth.uid() and kind=p_kind and entity_id=p_entity_id and version=p_expected_version returning version into result;
  end if;
  if result is null then raise exception 'SYNC_CONFLICT'; end if;
  return result;
end $$;
revoke all on function public.save_sync_state(text,text,bigint,uuid,jsonb) from public,anon;
grant execute on function public.save_sync_state(text,text,bigint,uuid,jsonb) to authenticated;

-- A member may install the personal bank once. No key/UUID/text changes by reimport.
create function public.install_bank(p_source jsonb,p_report jsonb) returns void
language plpgsql security definer set search_path='' as $$
declare s jsonb; q jsonb; a jsonb; existing jsonb; n integer; begin
  if not exists(select 1 from public.app_members where user_id=auth.uid()) then raise exception 'MEMBERSHIP_REQUIRED'; end if;
  perform pg_advisory_xact_lock(183961);
  select source into existing from public.bank_source where bank_id=1;
  if existing is not null then
    if existing <> p_source then raise exception 'BANK_CHANGE_REQUIRES_REVIEW'; end if;
    return;
  end if;
  if jsonb_typeof(p_source->'sections') is distinct from 'array' or jsonb_typeof(p_source->'questions') is distinct from 'array'
    or jsonb_array_length(p_source->'sections')=0 or jsonb_array_length(p_source->'questions')=0
    or coalesce(p_report->>'sha256','') !~ '^[a-f0-9]{64}$' then raise exception 'INVALID_BANK'; end if;
  if (p_report->>'sections')::integer is distinct from jsonb_array_length(p_source->'sections')
    or (p_report->>'questions')::integer is distinct from jsonb_array_length(p_source->'questions')
    or (p_report->>'answers')::integer is distinct from (select sum(jsonb_array_length(entry.value->'answers')) from jsonb_array_elements(p_source->'questions') entry(value))
    then raise exception 'BANK_COUNT'; end if;
  n:=0;
  for s in select value from jsonb_array_elements(p_source->'sections') loop
    n:=n+1;
    if (s->>'section_order')::integer<>n then raise exception 'SECTION_ORDER'; end if;
    if (s->>'question_count')::integer <> (select count(*) from jsonb_array_elements(p_source->'questions') x where x->>'section_id'=s->>'section_id') then raise exception 'SECTION_COUNT'; end if;
    insert into public.sections(section_id,section_order,section_code,section_title)
      values((s->>'section_id')::uuid,n,(s->>'section_code')::integer,s->>'section_title');
  end loop;
  for q in select value from jsonb_array_elements(p_source->'questions') loop
    if coalesce((q->>'deleted')::boolean,true) or coalesce((q->>'disabled')::boolean,true) then raise exception 'DISABLED_QUESTION'; end if;
    if jsonb_typeof(q->'answers') is distinct from 'array' or jsonb_array_length(q->'answers')=0 then raise exception 'ANSWER_KEY'; end if;
    if (select count(*) from jsonb_array_elements(q->'answers') x where x->>'is_correct'='true')<>1 then raise exception 'ANSWER_KEY'; end if;
    if exists(select 1 from jsonb_array_elements(q->'answers') with ordinality x(v,i) where (v->>'answer_order')::integer<>i or jsonb_typeof(v->'is_correct') is distinct from 'boolean' or coalesce((v->>'deleted')::boolean,true)) then raise exception 'ANSWER_ORDER'; end if;
    insert into public.questions(question_id,section_id,question_order,question_code,text,explanation,explanation_url,keep_answer_order,source_updated_at,source_metadata)
      values((q->>'question_id')::uuid,(q->>'section_id')::uuid,(q->>'question_order')::integer,(q->>'question_code')::integer,q->>'text',q->>'explanation',q->>'explanation_url',(q->>'keep_answer_order')::boolean,q->>'updated_at',q);
    for a in select value from jsonb_array_elements(q->'answers') loop
      insert into public.answers(answer_id,question_id,answer_order,answer_code,text,is_correct)
        values((a->>'answer_id')::uuid,(q->>'question_id')::uuid,(a->>'answer_order')::integer,(a->>'answer_code')::integer,a->>'text',(a->>'is_correct')::boolean);
    end loop;
  end loop;
  if exists(select 1 from public.questions group by section_id having min(question_order)<>1 or max(question_order)<>count(*)) then raise exception 'QUESTION_ORDER'; end if;
  insert into public.bank_source values(1,p_source,p_report);
  insert into public.bank_imports values(p_report->>'sha256',1,now(),p_report);
end $$;
revoke all on function public.install_bank(jsonb,jsonb) from public,anon;
grant execute on function public.install_bank(jsonb,jsonb) to authenticated;

-- Upload is limited to PNG paths referenced by the member-only installed bank.
create function public.allowed_question_image(p_path text) returns boolean language sql stable security definer set search_path='' as $$
  select exists(select 1 from public.app_members where user_id=auth.uid()) and exists(
    select 1 from public.bank_source b cross join lateral jsonb_array_elements(b.source->'questions') q
    cross join lateral jsonb_array_elements_text(q->'image_pngs') image_path where image_path=p_path)
$$;
revoke all on function public.allowed_question_image(text) from public,anon;
grant execute on function public.allowed_question_image(text) to authenticated;
create policy trainer_upload_images on storage.objects for insert to authenticated
  with check(bucket_id='question-images' and public.allowed_question_image(name));
-- No update/delete policy: imported assets are immutable; duplicate upload is checked by the client.
commit;
