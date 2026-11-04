import { afterEach, expect, it } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { unzipSync } from 'fflate'
import { TrainerDB, importBank } from '../src/storage/db'
import { move, retryQuestion, startSession, submitAnswer, visibleAttempt } from '../src/study/service'
import { deriveReview } from '../src/study/planner'
import { validateAnswerNumbers, answerReferences } from '../src/import/references'
import { displayAnswers } from '../src/domain/display'
import { demoBank } from './fixtures'
const databases:TrainerDB[]=[]
afterEach(async()=>{await Promise.all(databases.splice(0).map(d=>d.delete()))})
it('fresh review/random sessions hide history, commit independently, restore own feedback, keep coverage and retry cleanly',async()=>{
 const db=new TrainerDB('fresh-'+crypto.randomUUID());databases.push(db)
 await importBank(demoBank,[],{sha256:'test',sections:2,questions:18,answers:90,images:0,warnings:[]},db)
 const q=demoBank.questions[0]
 let original=await startSession('sequential',q.section_id,[q.question_id,demoBank.questions[1].question_id],db)
 original=await submitAnswer(original,q.answers[4].answer_id,false,db)
 original=await move(original,1,db)
 const first=(await db.attempts.toArray())[0]
 for(const mode of ['review','random'] as const){
  let session=await startSession(mode,q.section_id,[q.question_id],db)
  expect(visibleAttempt(session,q.question_id,await db.attempts.toArray())).toBeUndefined()
  expect(await db.attempts.count()).toBe(mode==='review'?1:2)
  session=await submitAnswer(session,q.answers[0].answer_id,true,db)
  const current=visibleAttempt(session,q.question_id,await db.attempts.toArray())!
  expect(current).toMatchObject({mode,is_correct:false,is_unsure:true,session_id:session.session_id,answer_id:q.answers[0].answer_id})
  expect(current.answered_at).toBeTruthy();expect(current.attempt_id).not.toBe(first.attempt_id)
  await expect(submitAnswer(session,q.answers[0].answer_id,false,db)).rejects.toThrow('заново')
  session=await move(session,0,db)
  expect(visibleAttempt(session,q.question_id,await db.attempts.toArray())?.attempt_id).toBe(current.attempt_id)
  session=await retryQuestion(session,db)
  expect(visibleAttempt(session,q.question_id,await db.attempts.toArray())).toBeUndefined()
 }
 expect(await db.attempts.get(first.attempt_id)).toEqual(first)
 expect(deriveReview(await db.attempts.toArray(),[]).get(q.question_id)).toMatchObject({ever_answered:true,problematic:true})
 expect((await db.sessions.get(original.session_id))?.cursor).toBe(1)
 expect(visibleAttempt(original,q.question_id,await db.attempts.toArray())).toBeDefined()
})
it('embedded reviews are clean when prepared and normal sequential navigation still shows history',async()=>{
 const q=demoBank.questions[0],uuid=()=>crypto.randomUUID()
 const attempt={attempt_id:uuid(),user_id:uuid(),question_id:q.question_id,answer_id:q.answers[4].answer_id,is_correct:true,is_unsure:false,answered_at:new Date().toISOString(),session_id:uuid(),mode:'sequential' as const,device_id:uuid()}
 const session={session_id:uuid(),user_id:attempt.user_id,device_id:uuid(),mode:'sequential' as const,section_id:q.section_id,question_ids:[q.question_id],cursor:0,choices:{},retry_ids:[],version:1,status:'active' as const,updated_at:new Date().toISOString(),new_since_review:0,counted_new_ids:[],recent_ids:[],inserted_review_id:null}
 expect(visibleAttempt(session,q.question_id,[attempt])).toBe(attempt)
 expect(visibleAttempt({...session,inserted_review_id:q.question_id},q.question_id,[attempt])).toBeUndefined()
})
it('numeric references reject missing or duplicate codes without changing source order or keys',()=>{
 const q=structuredClone(demoBank.questions[0]);q.answers[0].text='Варианты 1 и/или 4'
 expect(answerReferences(q.answers[0].text)).toEqual([1,4]);validateAnswerNumbers(q)
 q.answers[0].text='Варианты 1 и 99';expect(()=>validateAnswerNumbers(q)).toThrow('отсутствующий')
 q.answers[0].answer_code=q.answers[1].answer_code;expect(()=>validateAnswerNumbers(q)).toThrow('Неоднозначные')
})
it.skipIf(!existsSync('platform_83_export.zip'))('archive references and keys agree with raw source (when private archive is available)',async()=>{
 const files=unzipSync(readFileSync('platform_83_export.zip'))
 const bank=JSON.parse(new TextDecoder().decode(files['platform_83/questions.json'])) as typeof demoBank
 const raw=JSON.parse(new TextDecoder().decode(files['platform_83/raw/pack_data.json'])) as {questions:{uuid:string;answers:{uuid:string;code:number;text:string;true:boolean}[]}[]}[]
 const rawQs=new Map(raw.flatMap(s=>s.questions).map(q=>[q.uuid,q]))
 for(const q of bank.questions){validateAnswerNumbers(q);expect(q.answers.map(a=>[a.answer_id,a.answer_code,a.text,a.is_correct])).toEqual(rawQs.get(q.question_id)!.answers.map(a=>[a.uuid,a.code,a.text,a.true]))}
 const q=bank.questions.find(q=>q.question_id==='4e3ea63e-ea9d-11e9-b4e1-0050569f2c05')!
 expect(displayAnswers(q).map(a=>a.answer_code)).toEqual([1,2,3,4,5,6])
 expect(q.answers.map(a=>a.answer_code)).toEqual([4,5,1,2,3,6])
 expect(answerReferences(q.answers.find(a=>a.is_correct)!.text)).toEqual([1,4])
 expect(q.answers.find(a=>a.answer_code===1)?.answer_order).toBe(3)
 expect(q.answers.find(a=>a.answer_code===4)?.answer_order).toBe(1)
 expect(q.answers.find(a=>a.is_correct)?.answer_id).toBe('6a2ee425-f176-11e9-8fc6-2016b949cb31')
})
