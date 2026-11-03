import { PGlite } from '@electric-sql/pglite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { demoBank } from './fixtures'
const owner='00000000-0000-4000-8000-000000900001',other='00000000-0000-4000-8000-000000900002'
const event='00000000-0000-4000-8000-000000900003'
const path=`images/png/${demoBank.questions[0].question_id}.png`
const source={...structuredClone(demoBank),image_manifest:[]}
source.questions[0].image_attached=true;source.questions[0].image_pngs=[path]
const report={sha256:'0'.repeat(64),sections:2,questions:18,answers:90,images:1,content_sha256:'1'.repeat(64),warnings:['ДЕМО']}
let pg:PGlite
async function as(role:string,id:string,sql:string,params:unknown[]=[]){
  await pg.exec(`reset role;set role ${role};select set_config('request.jwt.claim.sub','${id}',false);`)
  try{return await pg.query(sql,params)}finally{await pg.exec('reset role')}
}
const install=(id=owner,bank:unknown=source)=>as('authenticated',id,'select public.install_bank($1::jsonb,$2::jsonb)',[JSON.stringify(bank),JSON.stringify(report)])
beforeEach(async()=> {
  pg=new PGlite()
  await pg.exec(`create role anon;create role authenticated;create schema auth;
    create table auth.users(id uuid primary key);create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
    grant usage on schema auth to anon,authenticated;grant execute on function auth.uid() to anon,authenticated;
    create schema storage;create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
    create table storage.objects(id uuid primary key,bucket_id text,name text);alter table storage.objects enable row level security;
    grant usage on schema storage to anon,authenticated;grant select,insert on storage.objects to authenticated;grant select on storage.objects to anon;
    insert into auth.users values('${owner}'),('${other}');`)
  await pg.exec(readFileSync('supabase/migrations/202611030001_initial.sql','utf8'))
  await pg.exec(readFileSync('supabase/migrations/202611030002_cloud_sync.sql','utf8'))
  await pg.query('insert into public.app_members(user_id) values($1)',[owner])
},30_000)
afterEach(async()=>{await pg.close()})
describe('Private bank installer and mutable-state CAS in PostgreSQL',()=> {
  it('only the allowlisted owner installs once, UUIDs/keys/order remain intact, retry is idempotent',async()=> {
    await expect(install(other)).rejects.toThrow('MEMBERSHIP_REQUIRED')
    await expect(as('anon','','select public.install_bank($1::jsonb,$2::jsonb)',[JSON.stringify(source),JSON.stringify(report)])).rejects.toThrow('permission denied')
    await install();await install()
    expect((await pg.query('select * from public.questions')).rows).toHaveLength(18)
    expect((await pg.query('select * from public.answers')).rows).toHaveLength(90)
    const q=demoBank.questions[0]
    expect((await pg.query<{answer_id:string}>('select answer_id from public.answers where question_id=$1 and is_correct',[q.question_id])).rows[0].answer_id).toBe(q.answers[4].answer_id)
    expect((await as('authenticated',other,'select * from public.bank_source')).rows).toHaveLength(0)
    await expect(as('anon','','select * from public.bank_source')).rejects.toThrow('permission denied')
    const changed=structuredClone(source);changed.questions[0].text='ДЕМО: изменено'
    await expect(install(owner,changed)).rejects.toThrow('BANK_CHANGE_REQUIRES_REVIEW')
    expect((await pg.query('select * from public.bank_source')).rows).toHaveLength(1)
  })
  it('rolls the whole installation back if one key/order/relationship is malformed',async()=> {
    const malformed=structuredClone(source);malformed.questions[1].answers[0].is_correct=true
    await expect(install(owner,malformed)).rejects.toThrow('ANSWER_KEY')
    expect((await pg.query('select * from public.sections')).rows).toHaveLength(0)
    expect((await pg.query('select * from public.answers')).rows).toHaveLength(0)
    await expect(install(owner,{})).rejects.toThrow('INVALID_BANK')
  })
  it('private Storage accepts only referenced PNG paths and denies anon/outsiders',async()=> {
    await install()
    const upload=`insert into storage.objects values('${event}','question-images',$1)`
    await expect(as('authenticated',other,upload,[path])).rejects.toThrow('row-level security')
    await expect(as('authenticated',owner,upload,['not-referenced.png'])).rejects.toThrow('row-level security')
    await as('authenticated',owner,upload,[path])
    expect((await as('authenticated',owner,'select * from storage.objects')).rows).toHaveLength(1)
    expect((await as('authenticated',other,'select * from storage.objects')).rows).toHaveLength(0)
    expect((await as('anon','','select * from storage.objects')).rows).toHaveLength(0)
  })
  it('CAS rejects stale/conflicting sessions and prevents cross-account changes',async()=> {
    const save=(id:string,version:number)=>as('authenticated',id,"select public.save_sync_state('preferences','theme',$1,$2,'{\"theme\":\"dark\"}')",[version,event])
    expect((await save(owner,0)).rows).toEqual([{save_sync_state:1}])
    await expect(save(owner,0)).rejects.toThrow('SYNC_CONFLICT')
    expect((await save(owner,1)).rows).toEqual([{save_sync_state:2}])
    await expect(save(owner,1)).rejects.toThrow('SYNC_CONFLICT')
    await expect(save(other,0)).rejects.toThrow('row-level security')
    expect((await as('authenticated',other,'select * from public.user_sync_state')).rows).toHaveLength(0)
    await expect(as('anon','','select * from public.user_sync_state')).rejects.toThrow('permission denied')
    await expect(as('authenticated',owner,'update public.user_sync_state set version=1')).rejects.toThrow('SESSION_CONFLICT')
  })
})

it('generated setup works from an empty project, retries preserve history and never enrol another account',async()=> {
  execFileSync(process.execPath,['scripts/prepare-cloud-setup.mjs'])
  const fresh=new PGlite()
  try {
    await fresh.exec(`create role anon;create role authenticated;create schema auth;
      create table auth.users(id uuid primary key);create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
      grant usage on schema auth to anon,authenticated;grant execute on function auth.uid() to anon,authenticated;
      create schema storage;create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
      create table storage.objects(id uuid primary key,bucket_id text,name text);alter table storage.objects enable row level security;
      grant usage on schema storage to anon,authenticated;grant select,insert on storage.objects to authenticated;grant select on storage.objects to anon;
      insert into auth.users values('${owner}');`)
    const setup=readFileSync('private/setup-supabase.sql','utf8')
    await fresh.exec(setup)
    expect((await fresh.query('select user_id from public.app_members')).rows).toEqual([{user_id:owner}])
    await fresh.exec(setup)
    await fresh.exec(`insert into auth.users values('${other}')`)
    await fresh.exec(setup)
    expect((await fresh.query('select user_id from public.app_members')).rows).toEqual([{user_id:owner}])
    expect((await fresh.query('select public from storage.buckets')).rows).toEqual([{public:false}])
  }finally{await fresh.close()}
},30_000)
