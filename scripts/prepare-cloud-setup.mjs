import { readFile, mkdir, writeFile } from 'node:fs/promises'
const migrations=[
  ['public.app_members','supabase/migrations/202611030001_initial.sql','migration_one'],
  ['public.user_sync_state','supabase/migrations/202611030002_cloud_sync.sql','migration_two'],
  ['public.question_classification','supabase/migrations/202611100003_question_classification.sql','migration_three'],
]
let sql='-- Personal trainer setup. Run in the SQL Editor of your own Supabase project.\n-- Does not drop tables, overwrite history, or expose the bank publicly.\nbegin;\n'
for(const [marker,path,tag] of migrations) {
  const content=(await readFile(path,'utf8')).replace(/^begin;\s*/m,'').replace(/commit;\s*$/,'')
  sql+=`do $setup$ begin\n  if to_regclass('${marker}') is null then\n    execute $${tag}$\n${content}\n$${tag}$;\n  end if;\nend $setup$;\n`
}
sql+=`-- Bootstrap only the single Auth user of this personal project. Never pick an arbitrary account.\ndo $owner$ begin\n  if not exists(select 1 from public.app_members) then\n    if (select count(*) from auth.users)<>1 then\n      raise exception 'Expected exactly one personal Auth user. Choose the owner UUID explicitly.';\n    end if;\n    insert into public.app_members(user_id) select id from auth.users;\n  end if;\nend $owner$;\ncommit;\nselect 'trainer_cloud_ready' as status, count(*) as allowed_users from public.app_members;\n`
await mkdir('private',{recursive:true})
await writeFile('private/setup-supabase.sql',sql)
console.log('Prepared private/setup-supabase.sql (no secrets or paid content)')
