begin;

create table public.question_classification (
  question_id uuid primary key references public.questions(question_id),
  payload jsonb not null,
  version bigint not null check(version > 0),
  event_id uuid not null,
  updated_at timestamptz not null default now()
);
alter table public.question_classification enable row level security;
revoke all on public.question_classification from public, anon, authenticated;
grant select on public.question_classification to authenticated;
create policy member_classification_read on public.question_classification for select to authenticated
  using (exists(select 1 from public.app_members where user_id=(select auth.uid())));

create function public.save_question_classification(
  p_question_id uuid, p_expected_version bigint, p_event_id uuid, p_payload jsonb
) returns bigint language plpgsql security definer set search_path='' as $$
declare result bigint;
begin
  if not exists(select 1 from public.app_members where user_id=auth.uid()) then
    raise exception 'MEMBERSHIP_REQUIRED';
  end if;
  if p_expected_version is null or p_expected_version<0 or p_payload is null
    or jsonb_typeof(p_payload) is distinct from 'object'
    or jsonb_typeof(p_payload->'primary') is distinct from 'string'
    or jsonb_typeof(p_payload->'additional') is distinct from 'array'
    or length(p_payload::text)>512 then raise exception 'INVALID_CLASSIFICATION'; end if;
  if (p_payload-'primary'-'additional') <> '{}'::jsonb
    or (p_payload->>'primary') !~ '^[a-z_]{1,40}$'
    or jsonb_array_length(p_payload->'additional')>10
    or exists(select 1 from jsonb_array_elements(p_payload->'additional') as tag(value)
      where jsonb_typeof(value)<>'string' or (value #>> '{}') !~ '^[a-z_]{1,40}$'
        or value=p_payload->'primary')
    or (select count(distinct value) from jsonb_array_elements(p_payload->'additional') as tag(value))
      <>jsonb_array_length(p_payload->'additional') then raise exception 'INVALID_CLASSIFICATION'; end if;

  if p_expected_version=0 then
    insert into public.question_classification(question_id,payload,version,event_id)
      values(p_question_id,p_payload,1,p_event_id)
      on conflict(question_id) do nothing returning version into result;
  else
    update public.question_classification
      set payload=p_payload,version=version+1,event_id=p_event_id,updated_at=now()
      where question_id=p_question_id and version=p_expected_version
      returning version into result;
  end if;
  if result is null then raise exception 'SYNC_CONFLICT'; end if;
  return result;
end $$;
revoke all on function public.save_question_classification(uuid,bigint,uuid,jsonb) from public,anon;
grant execute on function public.save_question_classification(uuid,bigint,uuid,jsonb) to authenticated;
commit;
