import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { exportHistory, parseBackup, previewHistory, restoreHistory } from '../src/backup/history'
import { TrainerDB, importBank, profile } from '../src/storage/db'
import { bindAccount } from '../src/sync/engine'
import { move, setFlag, setUnsure, startSession, submitAnswer } from '../src/study/service'
import { demoBank } from './fixtures'
import { chooseExam, finishExam, startExam } from '../src/study/exam'
const databases:TrainerDB[]=[]
const owner='00000000-0000-4000-8000-000000900001',url='https://test.supabase.co'
async function device(bound=true) {
  const database=new TrainerDB('backup-'+crypto.randomUUID());databases.push(database)
  await importBank(demoBank,[],{sha256:'0'.repeat(64),sections:2,questions:18,answers:90,images:0,warnings:['ДЕМО']},database)
  if(bound)await bindAccount(database,owner,url,true)
  return database
}
let source:TrainerDB
beforeEach(async()=> {
  source=await device()
  const q=demoBank.questions[0],s=await startSession('sequential',q.section_id,demoBank.questions.slice(0,9).map(q=>q.question_id),source)
  await submitAnswer(s,q.answers[4].answer_id,false,source)
  await setUnsure((await source.attempts.toArray())[0],true,source)
  await setFlag(q.question_id,'bookmarked',true,source)
})
afterEach(async()=>{await Promise.all(databases.splice(0).map(d=>d.delete()))})
describe('Versioned personal history backup',()=> {
  it('cannot reopen a completed exam by restoring its unfinished backup',async()=> {
    let s=await startExam(source)
    const q=demoBank.questions.find(q=>q.question_id===s.question_ids[0])!
    s=await chooseExam(s,q.answers[4].answer_id,source)
    const backup=await exportHistory(source)
    const completed=await finishExam(s.session_id,source)
    await restoreHistory(backup,'restore',source)
    expect(await source.sessions.get(s.session_id)).toEqual(completed)
    await finishExam(s.session_id,source)
    expect(await source.attempts.where('session_id').equals(s.session_id).count()).toBe(1)
  })
  it('exports no bank/auth data, previews, restores all events and deduplicates repeated imports',async()=> {
    const backup=await exportHistory(source),text=JSON.stringify(backup)
    expect(text).not.toContain('ДЕМО: синтетический')
    expect(text).not.toContain('publishable');expect(text).not.toContain('password')
    const target=await device()
    expect((await previewHistory(parseBackup(text),target)).newAttempts).toBe(1)
    await restoreHistory(backup,'keep',target)
    await restoreHistory(backup,'keep',target)
    expect(await target.attempts.toArray()).toEqual(await source.attempts.toArray())
    expect(await target.annotations.toArray()).toEqual(await source.annotations.toArray())
    expect(await target.flags.toArray()).toEqual(await source.flags.toArray())
    expect((await target.sessions.toArray())[0].status).toBe('paused')
    expect((await target.outbox.toArray()).filter(e=>e.kind==='attempt')).toHaveLength(1)
    expect((await previewHistory(backup,target)).newAttempts).toBe(0)
  })
  it('retains independent attempts and local session position unless restoration is explicitly selected',async()=> {
    const backup=await exportHistory(source),s=(await source.sessions.toArray())[0]
    const changed=await move(s,3,source)
    const q=demoBank.questions[3]
    await submitAnswer(changed,q.answers[0].answer_id,false,source)
    expect((await previewHistory(backup,source)).sessionConflicts).toBe(1)
    await restoreHistory(backup,'keep',source)
    expect((await source.sessions.get(s.session_id))?.cursor).toBe(3)
    await restoreHistory(backup,'restore',source)
    expect((await source.sessions.get(s.session_id))?.cursor).toBe(0)
    expect(await source.attempts.count()).toBe(2)
    expect((await source.meta.toArray()).some(m=>m.key.startsWith('beforeRestore:'))).toBe(true)
  })
  it('rejects altered immutable UUID, invalid keys, references, owner and versions atomically',async()=> {
    const backup=await exportHistory(source)
    for(const mutate of [
      (b:typeof backup)=>{b.attempts[0].is_unsure=true},
      (b:typeof backup)=>{b.attempts[0].answer_id=demoBank.questions[1].answers[0].answer_id},
      (b:typeof backup)=>{b.annotations[0].attempt_id=crypto.randomUUID()},
      (b:typeof backup)=>{b.user_id=crypto.randomUUID()},
      (b:typeof backup)=>{b.sessions[0].choices[demoBank.questions[0].question_id]=demoBank.questions[1].answers[0].answer_id},
    ]) {
      const copy=structuredClone(backup);mutate(copy)
      await expect(restoreHistory(copy,'restore',source)).rejects.toThrow()
      expect(await exportHistory(source)).toMatchObject({attempts:backup.attempts,annotations:backup.annotations,sessions:backup.sessions})
    }
    expect(()=>parseBackup(JSON.stringify({...backup,version:99}))).toThrow('версии 1')
  })
  it('revalidates after preview, keeps this device ID and supports an empty local browser',async()=> {
    const local=await device(false),backup=await exportHistory(source),p=await profile(local)
    // An unbound browser may adopt a personal backup without importing auth tokens.
    await restoreHistory(backup,'keep',local)
    expect(await profile(local)).toEqual({id:owner,device_id:p.device_id})
    expect(await local.meta.get('cloudBinding')).toBeUndefined()
    const preview=await previewHistory(backup,source);expect(preview.newAttempts).toBe(0)
    const tampered=structuredClone(backup.attempts[0]);tampered.is_unsure=true
    await source.attempts.put(tampered)
    await expect(restoreHistory(backup,'restore',source)).rejects.toThrow('UUID попытки')
    expect(await source.attempts.get(tampered.attempt_id)).toEqual(tampered)
  })
})
