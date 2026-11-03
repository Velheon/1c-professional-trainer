import type { Attempt, Question, Session } from '../domain/model'
import { db } from '../storage/db'
import { enqueue } from '../sync/queue'
import { randomSelection, secureRandom } from './planner'
import { currentId, startSession, updateSession } from './service'
export const EXAM_MS=30*60_000
// One question per section for the 14-section bank; this is a practice selection,
// not a claim about the unpublished official distribution.
export function examSelection(questions:Question[],rng:()=>number):string[] {
  const active=questions.filter(q=>!q.deleted&&!q.disabled)
  if(active.length<14)throw new Error('Для пробного экзамена нужно не менее 14 активных вопросов')
  const groups=new Map<string,Question[]>()
  for(const q of active)groups.set(q.section_id,[...(groups.get(q.section_id)??[]),q])
  const selected:string[]=[]
  while(selected.length<14) {
    for(const group of groups.values()) {
      const available=group.filter(q=>!selected.includes(q.question_id))
      if(available.length)selected.push(randomSelection(available,new Map(),'all',1,rng)[0])
      if(selected.length===14)break
    }
  }
  return randomSelection(active.filter(q=>selected.includes(q.question_id)),new Map(),'all','all',rng)
}
export async function startExam(database=db,now=new Date(),rng=secureRandom) {
  const ids=examSelection(await database.questions.toArray(),rng)
  return startSession('exam',null,ids,database,{started_at:now.toISOString(),deadline_at:new Date(now.getTime()+EXAM_MS).toISOString(),choice_times:{}})
}
export async function chooseExam(session:Session,answer_id:string,database=db,now=new Date()) {
  return database.transaction('rw',[database.sessions,database.questions,database.outbox],async()=> {
    if(session.mode!=='exam'||!session.exam||session.status==='completed')throw new Error('Экзамен уже завершён')
    if(now.getTime()<Date.parse(session.exam.started_at))throw new Error('Часы устройства изменились. Проверьте время перед продолжением экзамена.')
    if(now.getTime()>=Date.parse(session.exam.deadline_at))throw new Error('Время экзамена истекло. Завершите экзамен для просмотра результата.')
    const id=currentId(session),q=await database.questions.get(id)
    if(!q?.answers.some(a=>a.answer_id===answer_id))throw new Error('Ответ не принадлежит вопросу')
    return updateSession(session,{choices:{...session.choices,[id]:answer_id},exam:{...session.exam,choice_times:{...session.exam.choice_times,[id]:now.toISOString()}}},database)
  })
}
export async function finishExam(session_id:string,database=db,now=new Date()) {
  return database.transaction('rw',[database.sessions,database.questions,database.attempts,database.outbox],async()=> {
    const s=await database.sessions.get(session_id)
    if(s?.mode!=='exam'||!s.exam)throw new Error('Экзамен не найден')
    if(s.status==='completed')return s
    const finished_at=new Date(Math.min(now.getTime(),Date.parse(s.exam.deadline_at))).toISOString()
    for(const [question_id,answer_id] of Object.entries(s.choices)) {
      if(!s.question_ids.includes(question_id))throw new Error('Посторонний вопрос в экзамене')
      const q=await database.questions.get(question_id),a=q?.answers.find(a=>a.answer_id===answer_id)
      const answered_at=s.exam.choice_times[question_id]
      if(!a||!answered_at||Date.parse(answered_at)>Date.parse(s.exam.deadline_at)||Date.parse(answered_at)<Date.parse(s.exam.started_at))throw new Error('Некорректный экзаменационный выбор')
      const attempt:Attempt={attempt_id:crypto.randomUUID(),user_id:s.user_id,device_id:s.device_id,session_id:s.session_id,mode:'exam',question_id,answer_id,is_correct:a.is_correct,is_unsure:false,answered_at}
      await database.attempts.add(attempt);await enqueue(database,'attempt',attempt.attempt_id,s.user_id,attempt)
    }
    return updateSession(s,{status:'completed',exam:{...s.exam,finished_at}},database)
  })
}
export function examResult(s:Session,questions:Question[]) {
  const correct=s.question_ids.filter(id=>questions.find(q=>q.question_id===id)?.answers.some(a=>a.answer_id===s.choices[id]&&a.is_correct)).length
  return {correct,passed:correct>=12,answered:Object.keys(s.choices).length,total:s.question_ids.length}
}
