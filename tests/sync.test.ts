import Dexie from 'dexie'
import { afterEach, describe, expect, it } from 'vitest'
import { TrainerDB, importBank, profile } from '../src/storage/db'
import { move, resumeSession, setUnsure, startSession, submitAnswer } from '../src/study/service'
import { bindAccount, mergeHistory, resolveConflict, synchronize, type SyncTransport } from '../src/sync/engine'
import { canonical, keyOf, type MutableKind, type Outbox, type RemoteState } from '../src/sync/model'
import type { Annotation, Attempt, ImportReport } from '../src/domain/model'
import { demoBank } from './fixtures'
import { deriveReview } from '../src/study/planner'
const owner='00000000-0000-4000-8000-000000900001',other='00000000-0000-4000-8000-000000900002'
const url='https://test.supabase.co'
const report:ImportReport={sha256:'0'.repeat(64),sections:2,questions:18,answers:90,images:0,warnings:['ДЕМО']}
const databases:TrainerDB[]=[]
async function device() {
  const db=new TrainerDB('sync-test-'+crypto.randomUUID());databases.push(db)
  await importBank(demoBank,[],report,db)
  await bindAccount(db,owner,url,true)
  return db
}
afterEach(async()=> {await Promise.all(databases.splice(0).map(db=>db.delete()))})
class FakeCloud implements SyncTransport {
  history=new Map<string,Attempt>();notes=new Map<string,Annotation>();mutable=new Map<string,RemoteState>()
  loseImmutableResponse=false;loseStateResponse=false;fail=false
  async attempts(){if(this.fail)throw new Error('offline');return [...this.history.values()].map(v=>structuredClone(v))}
  async annotations(){return [...this.notes.values()].map(v=>structuredClone(v))}
  async states(){return [...this.mutable.values()].map(v=>structuredClone(v))}
  async putImmutable(e:Outbox) {
    if(e.kind==='attempt') {
      const a=e.payload as Attempt,old=this.history.get(a.attempt_id)
      if(old&&canonical(old)!==canonical(a))throw new Error('immutable conflict')
      this.history.set(a.attempt_id,structuredClone(a))
    }else {
      const a=e.payload as Annotation,old=this.notes.get(a.event_id)
      if(old&&canonical(old)!==canonical(a))throw new Error('immutable conflict')
      this.notes.set(a.event_id,structuredClone(a))
    }
    if(this.loseImmutableResponse){this.loseImmutableResponse=false;throw new Error('response lost')}
  }
  async putState(e:Outbox,expected:number) {
    const old=this.mutable.get(e.key)
    if((old?.version??0)!==expected)throw new Error('SYNC_CONFLICT')
    const value:RemoteState={user_id:e.user_id,kind:e.kind as MutableKind,entity_id:e.entity_id,version:expected+1,event_id:e.event_id,payload:structuredClone(e.payload),updated_at:new Date().toISOString()}
    this.mutable.set(e.key,value)
    if(this.loseStateResponse){this.loseStateResponse=false;throw new Error('response lost')}
    return value.version
  }
  async state(kind:MutableKind,id:string){return structuredClone(this.mutable.get(keyOf(kind,id))??null)}
}
describe('Cloud ownership and immutable history',()=> {
  it('requires explicit binding, preserves IDs/results and invalidates stale session references',async()=> {
    const db=new TrainerDB('local-'+crypto.randomUUID());databases.push(db)
    await importBank(demoBank,[],report,db)
    let s=await startSession('sequential',demoBank.sections[0].section_id,demoBank.questions.slice(0,9).map(q=>q.question_id),db)
    s=await submitAnswer(s,demoBank.questions[0].answers[4].answer_id,false,db)
    const before=(await db.attempts.toArray())[0]
    await expect(bindAccount(db,owner,url,false)).rejects.toThrow('Подтвердите')
    await bindAccount(db,owner,url,true)
    expect(await db.attempts.get(before.attempt_id)).toEqual({...before,user_id:owner})
    expect(await db.meta.get('beforeCloudBinding')).toBeDefined()
    await expect(move(s,1,db)).rejects.toThrow('другой вкладке')
    await expect(bindAccount(db,other,url,true)).rejects.toThrow('другому аккаунту')
    expect((await profile(db)).id).toBe(owner)
    expect((await db.outbox.toArray()).every(e=>e.user_id===owner)).toBe(true)
  })
  it('merges both independent attempts and recomputes the latest review outcome',async()=> {
    const a=await device(),b=await device(),remote=new FakeCloud(),q=demoBank.questions[0]
    const sa=await startSession('sequential',q.section_id,[q.question_id],a)
    const sb=await startSession('sequential',q.section_id,[q.question_id],b)
    await submitAnswer(sa,q.answers[4].answer_id,false,a)
    await submitAnswer(sb,q.answers[0].answer_id,true,b)
    const bAttempt=(await b.attempts.toArray())[0]
    // Explicit future time gives deterministic ordering for independent offline devices.
    const later={...bAttempt,answered_at:'2099-01-01T00:00:00.000Z'}
    await b.attempts.put(later)
    const event=await b.outbox.get(keyOf('attempt',later.attempt_id));await b.outbox.put({...event!,payload:later})
    await synchronize(a,owner,remote);await synchronize(b,owner,remote);await synchronize(a,owner,remote)
    expect(await a.attempts.count()).toBe(2);expect(await b.attempts.count()).toBe(2)
    expect(deriveReview(await a.attempts.toArray(),[]).get(q.question_id)?.problematic).toBe(true)
    expect((await b.conflicts.toArray()).some(c=>c.local.kind==='active')).toBe(true)
  })
  it('rejects alien history and mismatched immutable duplicates without changing existing attempts',async()=> {
    const db=await device(),q=demoBank.questions[0]
    const s=await startSession('sequential',q.section_id,[q.question_id],db)
    await submitAnswer(s,q.answers[4].answer_id,false,db)
    const a=(await db.attempts.toArray())[0]
    await expect(mergeHistory(db,owner,[{...a,user_id:other}],[])).rejects.toThrow('чужую')
    await expect(mergeHistory(db,owner,[{...a,is_unsure:true}],[])).rejects.toThrow('неизменяемой')
    expect(await db.attempts.get(a.attempt_id)).toEqual(a)
  })
})
describe('Outbox retry and conflict recovery',()=> {
  it('keeps local data after network failure; retry after a lost response never duplicates an attempt',async()=> {
    const db=await device(),remote=new FakeCloud(),q=demoBank.questions[0]
    const s=await startSession('sequential',q.section_id,[q.question_id],db)
    await submitAnswer(s,q.answers[4].answer_id,false,db)
    remote.fail=true
    await expect(synchronize(db,owner,remote)).rejects.toThrow('offline')
    expect(await db.attempts.count()).toBe(1);expect(await db.outbox.count()).toBeGreaterThan(0)
    remote.fail=false;remote.loseImmutableResponse=true
    await expect(synchronize(db,owner,remote)).rejects.toThrow('response lost')
    expect(remote.history.size).toBe(1)
    remote.loseStateResponse=true
    await synchronize(db,owner,remote);await synchronize(db,owner,remote)
    expect(remote.history.size).toBe(1);expect(await db.outbox.count()).toBe(0)
  })
  it('keeps edits made during upload in the outbox until the newer revision is sent',async()=> {
    const db=await device(),remote=new FakeCloud(),q=demoBank.questions[0]
    const s=await startSession('sequential',q.section_id,demoBank.questions.slice(0,9).map(q=>q.question_id),db)
    const original=remote.putState.bind(remote)
    let edited=false
    remote.putState=async(event,version)=> {
      const result=await original(event,version)
      if(event.kind==='session'&&!edited){edited=true;await move(s,2,db)}
      return result
    }
    await synchronize(db,owner,remote)
    expect(await db.outbox.get(keyOf('session',s.session_id))).toBeDefined()
    await synchronize(db,owner,remote)
    expect((remote.mutable.get(keyOf('session',s.session_id))!.payload as {cursor:number}).cursor).toBe(2)
    expect(await db.outbox.count()).toBe(0)
  })
  it('preserves both conflicting sessions and both histories; explicit resolution protects newer local edits',async()=> {
    const a=await device(),b=await device(),remote=new FakeCloud(),q=demoBank.questions[0]
    let s=await startSession('sequential',q.section_id,demoBank.questions.slice(0,9).map(q=>q.question_id),a)
    await synchronize(a,owner,remote);await synchronize(b,owner,remote)
    const bCopy=await b.sessions.get(s.session_id)
    expect((await b.meta.get('remoteActive'))?.value).toBe(s.session_id)
    const onB=await resumeSession(bCopy!,b)
    expect(onB.device_id).toBe((await profile(b)).device_id)
    s=await move(s,2,a);await move(onB,4,b)
    await synchronize(a,owner,remote);await synchronize(b,owner,remote)
    const collision=await b.conflicts.get(keyOf('session',s.session_id))
    expect(collision).toBeDefined()
    expect((collision!.local.payload as {cursor:number}).cursor).toBe(4)
    expect((collision!.remote.payload as {cursor:number}).cursor).toBe(2)
    await resolveConflict(b,collision!,'local')
    await synchronize(b,owner,remote)
    expect((remote.mutable.get(keyOf('session',s.session_id))!.payload as {cursor:number}).cursor).toBe(4)
    expect((await b.meta.toArray()).some(v=>v.key.startsWith('resolvedConflict:'))).toBe(true)
    await synchronize(a,owner,remote)
    expect((await a.meta.get('activeSession'))?.value).toBeNull()
    expect((await a.meta.get('remoteActive'))?.value).toBe(s.session_id)
  })
  it('merges immutable confidence events without replacing the attempt',async()=> {
    const a=await device(),b=await device(),remote=new FakeCloud(),q=demoBank.questions[0]
    const s=await startSession('sequential',q.section_id,[q.question_id],a)
    await submitAnswer(s,q.answers[4].answer_id,false,a)
    await synchronize(a,owner,remote);await synchronize(b,owner,remote)
    const original=(await b.attempts.toArray())[0]
    await setUnsure(original,true,b);await synchronize(b,owner,remote);await synchronize(a,owner,remote)
    expect(await a.attempts.get(original.attempt_id)).toEqual(original)
    expect(deriveReview(await a.attempts.toArray(),await a.annotations.toArray()).get(q.question_id)?.confidence).toBe(false)
  })
})

it('upgrades the original IndexedDB schema without resetting attempts or identity',async()=> {
  const name='upgrade-'+crypto.randomUUID(),old=new Dexie(name)
  old.version(1).stores({sections:'section_id,section_order',questions:'question_id,section_id,[section_id+question_order]',images:'path,question_id',attempts:'attempt_id,question_id,session_id,answered_at',annotations:'event_id,attempt_id',sessions:'session_id,status,updated_at',flags:'question_id',meta:'key'})
  const q=demoBank.questions[0]
  const attempt:Attempt={attempt_id:crypto.randomUUID(),user_id:owner,question_id:q.question_id,answer_id:q.answers[4].answer_id,is_correct:true,is_unsure:false,answered_at:'2026-11-03T10:00:00.000Z',session_id:crypto.randomUUID(),device_id:crypto.randomUUID(),mode:'sequential'}
  await old.table('attempts').add(attempt)
  await old.table('meta').add({key:'profile',value:{id:owner,device_id:attempt.device_id}})
  old.close()
  const upgraded=new TrainerDB(name);databases.push(upgraded)
  expect(await upgraded.attempts.toArray()).toEqual([attempt])
  expect((await profile(upgraded)).device_id).toBe(attempt.device_id)
  expect(await upgraded.outbox.count()).toBe(0)
  expect(upgraded.verno).toBe(2)
})
