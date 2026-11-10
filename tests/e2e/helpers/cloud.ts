import { expect, type BrowserContext, type Page, type Route } from '@playwright/test'
import { zipSync, strToU8 } from 'fflate'
import { createHash } from 'node:crypto'
import { demoBank } from '../../fixtures'
const owner='00000000-0000-4000-8000-000000900001',other='00000000-0000-4000-8000-000000900002'
// Synthetic API only. Never signs in to the owner's Supabase or uses real credentials.
export function fixtureZip() {
  const files:Record<string,Uint8Array>={'platform_83/questions.json':strToU8(JSON.stringify(demoBank)),'platform_83/images_manifest.json':strToU8('[]')}
  const hashes=Object.fromEntries(Object.entries(files).map(([name,data])=>[name.slice('platform_83/'.length),createHash('sha256').update(data).digest('hex')]))
  files['platform_83/sha256.json']=strToU8(JSON.stringify(hashes))
  return {name:'demo-synthetic.zip',mimeType:'application/zip',buffer:Buffer.from(zipSync(files))}
}
function fakeToken(id:string) {
  const part=(x:unknown)=>Buffer.from(JSON.stringify(x)).toString('base64url')
  return part({alg:'HS256',typ:'JWT'})+'.'+part({sub:id,aud:'authenticated',role:'authenticated',exp:Math.floor(Date.now()/1000)+3600})+'.synthetic_signature'
}
export class SyntheticAPI {
  constructor(private acceptProductionHost=false) {}
  source:unknown=null;report:unknown=null
  logoutBarrier:Promise<void>|null=null
  membershipBarrier:Promise<void>|null=null
  memberEnabled=true
  membershipRequests=0
  tags:Record<string,Record<string,unknown>>={}

  attempts:Record<string,Record<string,unknown>>={};annotations:Record<string,Record<string,unknown>>={};states:Record<string,Record<string,unknown>>={}
  async connect(context:BrowserContext) {
    await context.route('https://**.supabase.co/**',route=>this.handle(route))
  }
  async handle(route:Route) {
    const request=route.request(),url=new URL(request.url())
    if(!this.acceptProductionHost&&url.host!=='test.supabase.co'){await route.abort();throw new Error('Test attempted to contact a real Supabase project')}
    const data=(body:unknown,status=200)=>route.fulfill({status,contentType:'application/json',body:JSON.stringify(body)})
    const bearer=request.headers().authorization?.replace('Bearer ','')??''
    let uid=''
    try {uid=(JSON.parse(Buffer.from(bearer.split('.')[1],'base64url').toString()) as {sub:string}).sub}catch { /* No authenticated user */ }
    if(url.pathname==='/auth/v1/token') {
      const body=request.postDataJSON() as {email:string}
      const id=body.email==='owner@example.invalid'?owner:other
      return data({access_token:fakeToken(id),refresh_token:'synthetic-refresh',expires_in:3600,expires_at:Math.floor(Date.now()/1000)+3600,token_type:'bearer',user:{id,aud:'authenticated',role:'authenticated',email:body.email,app_metadata:{provider:'email'},user_metadata:{},created_at:'2026-01-01T00:00:00.000Z'}})
    }
    if(url.pathname==='/auth/v1/logout'){await this.logoutBarrier;return data({})}
    if(url.pathname==='/rest/v1/app_members'){
      this.membershipRequests++
      await this.membershipBarrier
      return data(uid===owner&&this.memberEnabled?[{user_id:owner}]:[])
    }
    if(uid!==owner)return data({message:'Forbidden'},403)
    if(url.pathname==='/rest/v1/bank_source')return data(this.source?[{source:this.source,report:this.report}]:[])
    if(url.pathname==='/rest/v1/rpc/install_bank') {
      const body=request.postDataJSON() as {p_source:unknown;p_report:unknown}
      this.source=body.p_source;this.report=body.p_report;return data(null)
    }
    if(url.pathname==='/rest/v1/rpc/save_sync_state') {
      const body=request.postDataJSON() as {p_kind:string;p_entity_id:string;p_expected_version:number;p_event_id:string;p_payload:unknown}
      const key=body.p_kind+':'+body.p_entity_id,old=this.states[key]
      if((old?.version??0)!==body.p_expected_version)return data({message:'SYNC_CONFLICT',code:'P0001'},400)
      const version=body.p_expected_version+1
      this.states[key]={user_id:owner,kind:body.p_kind,entity_id:body.p_entity_id,version,event_id:body.p_event_id,payload:body.p_payload,updated_at:new Date().toISOString()}
      return data(version)
    }
    if(url.pathname==='/rest/v1/question_classification'){
      return data(Object.values(this.tags).filter(row=>!url.searchParams.has('question_id')||url.searchParams.get('question_id')==='eq.'+row.question_id))
    }
    if(url.pathname==='/rest/v1/rpc/save_question_classification'){
      const body=request.postDataJSON() as {p_question_id:string;p_expected_version:number;p_event_id:string;p_payload:unknown}
      const old=this.tags[body.p_question_id]
      if((old?.version??0)!==body.p_expected_version)return data({message:'SYNC_CONFLICT',code:'P0001'},400)
      const version=body.p_expected_version+1
      this.tags[body.p_question_id]={question_id:body.p_question_id,version,event_id:body.p_event_id,payload:body.p_payload,updated_at:new Date().toISOString()}
      return data(version)
    }
    if(url.pathname==='/rest/v1/user_sync_state') {
      const rows=Object.values(this.states).filter(row=>['user_id','kind','entity_id'].every(k=>!url.searchParams.has(k)||url.searchParams.get(k)==='eq.'+row[k]))
      return data(rows)
    }
    const isAttempt=url.pathname==='/rest/v1/attempts',isAnnotation=url.pathname==='/rest/v1/attempt_annotations'
    if(isAttempt||isAnnotation) {
      const records=isAttempt?this.attempts:this.annotations,id=isAttempt?'attempt_id':'event_id'
      if(request.method()==='POST') {
        const row=request.postDataJSON() as Record<string,unknown>
        if(row.user_id!==owner)return data({message:'Forbidden'},403)
        records[String(row[id])]??=row;return route.fulfill({status:201,body:''})
      }
      const rows=Object.values(records).filter(row=>!url.searchParams.has(id)||url.searchParams.get(id)==='eq.'+row[id])
      return data(request.headers().accept?.includes('vnd.pgrst.object')?rows[0]:rows)
    }
    return data({message:'Unimplemented synthetic endpoint: '+url.pathname},500)
  }
}
export async function login(page:Page,email='owner@example.invalid') {
  const connect=page.getByRole('button',{name:'Подключить облако',exact:true})
  if(!await page.getByLabel('Email аккаунта тренажёра',{exact:true}).isVisible()) {await expect(connect).toBeVisible();await connect.click()}
  await page.getByLabel('Email аккаунта тренажёра',{exact:true}).fill(email)
  await page.getByLabel('Пароль',{exact:true}).fill('DEMO-only-not-a-real-password')
  await page.getByRole('button',{name:'Войти',exact:true}).click()
}
export async function bind(page:Page) {
  await page.getByRole('checkbox',{name:/Привязать этот браузер/}).check()
  await page.getByRole('button',{name:'Подключить облако',exact:true}).last().click()
  await expect(page.locator('.cloud-bar [role=status]')).toHaveText('Синхронизировано',{timeout:30_000})
}
export async function attempts(page:Page) {
  return page.evaluate(async()=> {
    const req=indexedDB.open('1c-professional-trainer')
    const db=await new Promise<IDBDatabase>(resolve=>{req.onsuccess=()=>resolve(req.result)})
    const get=db.transaction('attempts').objectStore('attempts').getAll()
    return new Promise<Array<{attempt_id:string;device_id:string}>>(resolve=>{get.onsuccess=()=>{db.close();resolve(get.result)}})
  })
}
