-- Read-only checks. Simulates a non-member JWT subject under the real authenticated role.
-- This checks SQL/RLS; it is not an HTTP login by another real Auth account.
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000099',true);
select 'outsider_access' as check_name,
  (select count(*) from public.app_members) as memberships,
  (select count(*) from public.bank_source) as banks,
  (select count(*) from public.attempts) as attempts,
  (select count(*) from public.user_sync_state) as states;
rollback;
select tablename,rowsecurity as rls_enabled,
  has_table_privilege('anon',format('%I.%I',schemaname,tablename),'SELECT') as anon_can_select
from pg_tables where schemaname='public' and tablename in
  ('app_members','sections','questions','answers','question_images','bank_imports','bank_source',
   'attempts','attempt_annotations','study_sessions','user_question_flags','user_preferences','user_sync_state')
order by tablename;
select count(*) as protected_tables,
  bool_and(rowsecurity) as all_rls_enabled,
  bool_and(not has_table_privilege('anon',format('%I.%I',schemaname,tablename),'SELECT')) as anon_read_revoked,
  (select not public from storage.buckets where id='question-images') as image_bucket_private,
  (select count(*) from public.app_members) as allowed_users
from pg_tables where schemaname='public' and tablename in
  ('app_members','sections','questions','answers','question_images','bank_imports','bank_source',
   'attempts','attempt_annotations','study_sessions','user_question_flags','user_preferences','user_sync_state');
