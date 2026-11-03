import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { TrainerDB, importBank } from '../src/storage/db'
import { chooseExam, examResult, examSelection, EXAM_MS, finishExam, startExam } from '../src/study/exam'
import { move, submitAnswer } from '../src/study/service'
import { deriveReview } from '../src/study/planner'
import { sessionSchema } from '../src/sync/model'
import { demoBank } from './fixtures'
let db:TrainerDB
const start=new Date('2026-11-03T10:00:00.000Z'),during=new Date(start.getTime()+10_000)
beforeEach(async()=>{db=new TrainerDB('exam-'+crypto.randomUUID());await importBank(demoBank,[],{sha256:'test',sections:2,questions:18,answers:90,images:0,warnings:[]},db)})
afterEach(async()=>{await db.delete()})
describe('Practice exam',()=> {
  it('selects 14 unique questions across sections without changing answer order and saves its deadline',async()=> {
    const original=structuredClone(demoBank)
    const ids=examSelection(demoBank.questions,()=>0.5)
    expect(new Set(ids).size).toBe(14)
    expect(new Set(ids.map(id=>demoBank.questions.find(q=>q.question_id===id)!.section_id)).size).toBe(2)
    expect(demoBank).toEqual(original)
    const s=await startExam(db,start,()=>0.5)
    expect(Date.parse(s.exam!.deadline_at)).toBe(start.getTime()+EXAM_MS)
    expect(sessionSchema.parse(s)).toEqual(s)
    expect(()=>examSelection(demoBank.questions.slice(0,10),()=>0)).toThrow('14')
  })
  it('allows changing selections, preserves them across reload, rejects late choices, finalizes exactly once',async()=> {
    let s=await startExam(db,start,()=>0.5)
    const q=demoBank.questions.find(q=>q.question_id===s.question_ids[0])!
    s=await chooseExam(s,q.answers[0].answer_id,db,during)
    s=await chooseExam(s,q.answers[4].answer_id,db,during)
    expect(await db.attempts.count()).toBe(0)
    const name=db.name;db.close();db=new TrainerDB(name)
    s=(await db.sessions.get(s.session_id))!
    expect(s.choices[q.question_id]).toBe(q.answers[4].answer_id)
    await expect(chooseExam(s,q.answers[0].answer_id,db,new Date(start.getTime()+EXAM_MS))).rejects.toThrow('истекло')
    await expect(submitAnswer(s,q.answers[4].answer_id,false,db)).rejects.toThrow('после завершения')
    const [a,b]=await Promise.all([finishExam(s.session_id,db,new Date(start.getTime()+EXAM_MS+100)),finishExam(s.session_id,db,during)])
    expect(a).toEqual(b);expect(await db.attempts.count()).toBe(1)
    expect(examResult(a,demoBank.questions)).toMatchObject({correct:1,answered:1,passed:false})
    expect(deriveReview(await db.attempts.toArray(),[]).size).toBe(0)
  })
  it('passes at 12, fails at 11, and never creates attempts for unanswered questions',async()=> {
    for(const count of [11,12]) {
      let s=await startExam(db,start,()=>0.5)
      for(let i=0;i<count;i++) {
        s=await move(s,i,db)
        const q=demoBank.questions.find(q=>q.question_id===s.question_ids[i])!
        s=await chooseExam(s,q.answers[4].answer_id,db,during)
      }
      s=await finishExam(s.session_id,db,during)
      expect(examResult(s,demoBank.questions).passed).toBe(count===12)
      expect(await db.attempts.where('session_id').equals(s.session_id).count()).toBe(count)
    }
  })
})
