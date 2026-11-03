import { PGlite } from '@electric-sql/pglite'
import { beforeAll, afterAll, describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
let pg:PGlite
const owner='00000000-0000-4000-8000-000000000001'
const stranger='00000000-0000-4000-8000-000000000002'
const section='00000000-0000-4000-8000-000000000010',question='00000000-0000-4000-8000-000000000020',answer='00000000-0000-4000-8000-000000000030'
const attempt='00000000-0000-4000-8000-000000000040',session='00000000-0000-4000-8000-000000000050',device='00000000-0000-4000-8000-000000000060'
const insertAttempt=(id=attempt,user=owner,correct=true)=>`insert into public.attempts values ('${id}','${user}','${question}','${answer}',${correct},false,now(),'sequential','${session}','${device}')`
async function as(role:string,id:string,sql:string) {
  await pg.exec(`reset role; set role ${role}; select set_config('request.jwt.claim.sub','${id}',false);`)
  try {return await pg.query(sql)} finally {await pg.exec('reset role')}
}
beforeAll(async()=> {
  pg=new PGlite()
  await pg.exec(`
    create role anon; create role authenticated;
    create schema auth; create table auth.users(id uuid primary key);
    create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
    grant usage on schema auth to anon,authenticated; grant execute on function auth.uid() to anon,authenticated;
    create schema storage; create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
    create table storage.objects(id uuid primary key,bucket_id text,name text);
    alter table storage.objects enable row level security; grant usage on schema storage to anon,authenticated; grant select on storage.objects to anon,authenticated;
    insert into auth.users values('${owner}'),('${stranger}');
  `)
  await pg.exec(readFileSync('supabase/migrations/202611030001_initial.sql','utf8'))
  await pg.exec(`insert into public.app_members(user_id) values('${owner}');
    insert into public.sections values('${section}',1,1,'ДЕМО');
    insert into public.questions values('${question}','${section}',1,1,'ДЕМО','ДЕМО','',true,'2026-11-03','{}');
    insert into public.answers values('${answer}','${question}',1,1,'ДЕМО',true);
    insert into storage.objects values('${question}','question-images','demo.png');`)
},30_000)
afterAll(async()=> {await pg.close()})
describe('Actual PostgreSQL grants and RLS (local PGlite, not a hosted Supabase)',()=> {
  it('denies anon all API table reads and writes',async()=> {
    for(const table of ['app_members','sections','questions','answers','question_images','bank_imports','attempts','attempt_annotations','study_sessions','user_question_flags','user_preferences']) {
      await expect(as('anon','',`select * from public.${table}`)).rejects.toThrow('permission denied')
    }
    await expect(as('anon','',insertAttempt())).rejects.toThrow('permission denied')
  })
  it('allows only the allowlisted member to read the bank and private images',async()=> {
    expect((await as('authenticated',owner,'select * from public.questions')).rows).toHaveLength(1)
    expect((await as('authenticated',stranger,'select * from public.questions')).rows).toHaveLength(0)
    expect((await as('authenticated',stranger,'select * from public.app_members')).rows).toHaveLength(0)
    expect((await as('authenticated',owner,'select * from storage.objects')).rows).toHaveLength(1)
    expect((await as('authenticated',stranger,'select * from storage.objects')).rows).toHaveLength(0)
    expect((await as('anon','','select * from storage.objects')).rows).toHaveLength(0)
    expect((await pg.query<{public:boolean}>("select public from storage.buckets where id='question-images'")).rows[0].public).toBe(false)
  })
  it('denies self-enrolment, bank modification, and access to another user history',async()=> {
    await expect(as('authenticated',stranger,`insert into public.app_members(user_id) values('${stranger}')`)).rejects.toThrow('permission denied')
    await expect(as('authenticated',owner,"update public.questions set text='changed'")).rejects.toThrow('permission denied')
    await as('authenticated',owner,insertAttempt())
    expect((await as('authenticated',owner,'select * from public.attempts')).rows).toHaveLength(1)
    expect((await as('authenticated',stranger,'select * from public.attempts')).rows).toHaveLength(0)
    await expect(as('authenticated',stranger,insertAttempt('00000000-0000-4000-8000-000000000041',owner))).rejects.toThrow()
    await expect(as('authenticated',stranger,insertAttempt('00000000-0000-4000-8000-000000000042',stranger))).rejects.toThrow()
  })
  it('protects immutable history, prevents duplicates and rejects a false key',async()=> {
    await expect(as('authenticated',owner,"update public.attempts set is_correct=false")).rejects.toThrow('permission denied')
    await expect(as('authenticated',owner,'delete from public.attempts')).rejects.toThrow('permission denied')
    await expect(as('authenticated',owner,insertAttempt())).rejects.toThrow('duplicate key')
    await expect(as('authenticated',owner,insertAttempt('00000000-0000-4000-8000-000000000043',owner,false))).rejects.toThrow('Answer key')
  })
  it('checks session versions and does not overwrite a concurrent revision',async()=> {
    const rpc=(version:number)=>`select public.save_study_session('${session}',${version},'${device}',now(),'{"cursor":2}')`
    expect((await as('authenticated',owner,rpc(0))).rows).toEqual([{save_study_session:1}])
    await expect(as('authenticated',owner,rpc(0))).rejects.toThrow('SESSION_CONFLICT')
    expect((await as('authenticated',owner,rpc(1))).rows).toEqual([{save_study_session:2}])
    await expect(as('authenticated',owner,rpc(1))).rejects.toThrow('SESSION_CONFLICT')
    expect((await as('authenticated',stranger,'select * from public.study_sessions')).rows).toHaveLength(0)
  })
})
