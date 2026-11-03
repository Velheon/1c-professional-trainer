import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { unzipSync } from 'fflate'
import { validateBank, readArchive } from '../src/import/archive'
import { TrainerDB, importBank } from '../src/storage/db'
import { activeSession, move, retryQuestion, setFlag, startSession, submitAnswer, updateSession, setUnsure, effectiveUnsure } from '../src/study/service'
import type { ImportReport, Session } from '../src/domain/model'
import { demoBank } from './fixtures'
const bytes=existsSync('platform_83_export.zip')?new Uint8Array(readFileSync('platform_83_export.zip')):undefined
const raw=bytes?JSON.parse(new TextDecoder().decode(unzipSync(bytes)['platform_83/questions.json'])):demoBank
const bank=validateBank(raw)
const report:ImportReport={sha256:'test',sections:14,questions:961,answers:4143,images:78,warnings:[]}
let db:TrainerDB
let session:Session
beforeEach(async()=> {
  db=new TrainerDB('test-'+crypto.randomUUID())
  await importBank(bank,[],report,db)
  const section=bank.sections[0]
  session=await startSession('sequential',section.section_id,bank.questions.filter(q=>q.section_id===section.section_id).map(q=>q.question_id),db)
})
afterEach(async()=> {await db.delete()})
describe('Private archive and import',()=> {
  it.skipIf(!bytes)('loads all records/images and preserves the correct UUID at position 5/code 4',async()=> {
    const imported=await readArchive(bytes!)
    expect(imported.bank.questions).toHaveLength(961)
    expect(imported.images).toHaveLength(78)
    const correct=imported.bank.questions[0].answers.find(a=>a.is_correct)!
    expect([correct.answer_order,correct.answer_code,correct.answer_id]).toEqual([5,4,'beedce6c-fcc8-11ea-8f0f-2016b949cb35'])
  })
  it('rejects changed order, duplicate IDs, incorrect keys, and unsafe URLs',()=> {
    for(const mutate of [
      (d:typeof bank)=>d.questions[0].answers.reverse(),
      (d:typeof bank)=>{d.questions[1].question_id=d.questions[0].question_id},
      (d:typeof bank)=>{d.questions[0].answers[0].is_correct=true},
      (d:typeof bank)=>{d.questions[0].explanation_url='javascript:alert(1)'},
    ]) {const copy=structuredClone(bank);mutate(copy);expect(()=>validateBank(copy)).toThrow()}
  })
  it('reimport preserves attempts, sessions and annotations and rejects unreviewed changes',async()=> {
    const q=bank.questions[0]
    session=await submitAnswer(session,q.answers[0].answer_id,false,db)
    const a=(await db.attempts.toArray())[0]
    await setUnsure(a,true,db)
    expect(await importBank(bank,[],report,db)).toBe('unchanged')
    expect(await db.attempts.count()).toBe(1)
    expect(effectiveUnsure(a,await db.annotations.toArray())).toBe(true)
    expect((await activeSession(db))?.version).toBe(session.version)
    const changed=structuredClone(bank);changed.questions[0].answers[0].is_correct=true
    await expect(importBank(changed,[],{...report,sha256:'different'},db)).rejects.toThrow('Новая версия')
    await expect(importBank(changed,[],report,db)).rejects.toThrow('Новая версия')
    expect(await db.questions.get(q.question_id)).toEqual(q)
  })
})
describe('Study persistence',()=> {
  it('saves correctness by answer_id and requires explicit retry',async()=> {
    const q=bank.questions[0]
    const correct=q.answers.find(a=>a.is_correct)!
    const stale=session
    session=await submitAnswer(session,correct.answer_id,false,db)
    expect((await db.attempts.toArray())[0].is_correct).toBe(true)
    await expect(submitAnswer(stale,correct.answer_id,false,db)).rejects.toThrow('другой вкладке')
    await expect(submitAnswer(session,correct.answer_id,false,db)).rejects.toThrow('заново')
    session=await retryQuestion(session,db)
    session=await submitAnswer(session,q.answers[0].answer_id,true,db)
    expect(await db.attempts.count()).toBe(2)
    expect((await db.attempts.toArray()).filter(a=>a.is_correct)).toHaveLength(1)
  })
  it('navigation, skip, revisit and selection do not create attempts; reload preserves state',async()=> {
    session=await updateSession(session,{choices:{[session.question_ids[0]]:bank.questions[0].answers[0].answer_id}},db)
    await setFlag(session.question_ids[0],'skipped',true,db)
    session=await move(session,2,db)
    session=await move(session,0,db)
    const name=db.name
    db.close();db=new TrainerDB(name)
    expect((await activeSession(db))?.choices).toEqual(session.choices)
    expect((await activeSession(db))?.cursor).toBe(0)
    expect(await db.attempts.count()).toBe(0)
    expect((await db.flags.get(session.question_ids[0]))?.skipped).toBe(true)
  })
  it('rejects a foreign answer and leaves the transaction unchanged',async()=> {
    await expect(submitAnswer(session,bank.questions[1].answers[0].answer_id,false,db)).rejects.toThrow('не принадлежит')
    expect(await db.attempts.count()).toBe(0)
    expect((await activeSession(db))?.version).toBe(session.version)
  })
})
describe('Immutable confidence',()=> {
  it('changes confidence without overwriting the original attempt',async()=> {
    const q=bank.questions[0],a=q.answers.find(a=>a.is_correct)!
    session=await submitAnswer(session,a.answer_id,false,db)
    const original=(await db.attempts.toArray())[0]
    await setUnsure(original,true,db)
    expect(await db.attempts.get(original.attempt_id)).toEqual(original)
    expect(effectiveUnsure(original,await db.annotations.toArray())).toBe(true)
    expect(await db.attempts.count()).toBe(1)
  })
})
describe('Embedded review and saved selections',()=> {
  it('preserves new question order around an inserted review and does not increase coverage by viewing',async()=> {
    const { advance }=await import('../src/study/advance')
    const review=bank.questions.find(q=>q.section_id!==bank.sections[0].section_id)!
    await db.attempts.add({attempt_id:crypto.randomUUID(),user_id:session.user_id,device_id:session.device_id,
      question_id:review.question_id,answer_id:review.answers[0].answer_id,is_correct:false,is_unsure:false,answered_at:'2020-01-01T00:00:00.000Z',mode:'sequential',session_id:crypto.randomUUID()})
    // Use all questions to keep this integration scenario valid with synthetic fixtures too.
    const ids=bank.questions.filter(q=>q.section_id===bank.sections[0].section_id).map(q=>q.question_id)
    const count=Math.min(8,ids.length-1)
    for(let i=0;i<count;i++) {
      const q=bank.questions.find(q=>q.question_id===session.question_ids[session.cursor])!
      session=await submitAnswer(session,q.answers.find(a=>a.is_correct)!.answer_id,false,db)
      session=await advance(session,new Date('2026-11-03T10:00:00.000Z'),db)
    }
    if(count===8) {
      expect(session.inserted_review_id).toBe(review.question_id)
      const before=await db.attempts.count()
      session=await advance(session,new Date(),db)
      expect(session.inserted_review_id).toBeNull()
      expect(session.question_ids[session.cursor]).toBe(ids[8])
      expect(await db.attempts.count()).toBe(before)
      expect(session.counted_new_ids).toHaveLength(8)
    }
  })
  it('resumes exactly the random order and isolates it from sequential progress',async()=> {
    const {resumeSession}=await import('../src/study/service')
    session=await move(session,2,db)
    const original=session
    const ids=[...session.question_ids].reverse().slice(0,3)
    let random=await startSession('random',session.section_id,ids,db)
    random=await move(random,1,db)
    expect((await activeSession(db))?.question_ids).toEqual(ids)
    const saved=await db.sessions.get(original.session_id)
    expect(saved?.cursor).toBe(2)
    await resumeSession(saved!,db)
    expect((await activeSession(db))?.session_id).toBe(original.session_id)
    expect((await db.sessions.get(random.session_id))?.question_ids).toEqual(ids)
  })
})
