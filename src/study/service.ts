import { db, profile, type TrainerDB } from '../storage/db'
import { compareEvents, type Attempt, type Mode, type Session } from '../domain/model'
import { enqueue } from '../sync/queue'
export { effectiveUnsure } from '../domain/model'
const now = () => new Date().toISOString()
export function currentId(session:Session) { return session.inserted_review_id ?? session.question_ids[session.cursor] }
export async function activeSession(database=db) {
  const id = (await database.meta.get('activeSession'))?.value
  return typeof id === 'string' ? database.sessions.get(id) : undefined
}
export async function startSession(mode:Mode, section_id:string|null, ids:string[], database=db, exam?:Session['exam']) {
  if (!ids.length || ids.length !== new Set(ids).size) throw new Error('Нет вопросов или в подборке есть повторы')
  if(mode==='exam'&&(!exam||ids.length!==14))throw new Error('Для экзамена нужны 14 вопросов и сохранённый таймер')
  const p = await profile(database)
  const session:Session = { session_id:crypto.randomUUID(),user_id:p.id,device_id:p.device_id,mode,section_id,question_ids:ids,
    cursor:0,choices:{},retry_ids:[],version:1,status:'active',updated_at:now(),new_since_review:0,counted_new_ids:[],recent_ids:[],inserted_review_id:null,...(exam?{exam}:{}) }
  await database.transaction('rw',[database.sessions,database.meta,database.outbox],async()=> {
    if((await profile(database)).id!==session.user_id)throw new Error('Профиль изменился. Обновите страницу; история сохранена.')
    const active = await activeSession(database)
    if (active?.status === 'active') {const paused:Session={...active,status:'paused',version:active.version+1,updated_at:now()};await database.sessions.put(paused);await enqueue(database,'session',paused.session_id,paused.user_id,paused)}
    await database.sessions.add(session)
    await enqueue(database,'session',session.session_id,session.user_id,session)
    await database.meta.put({key:'activeSession',value:session.session_id})
    await database.meta.delete('remoteActive')
    await enqueue(database,'active','active',session.user_id,{session_id:session.session_id})
  })
  return session
}
async function assertVersion(session:Session, database:TrainerDB) {
  const stored = await database.sessions.get(session.session_id)
  if (!stored || stored.version !== session.version || stored.user_id !== session.user_id) throw new Error('Сессия изменена в другой вкладке. Обновите страницу: ответы сохранены.')
  if (stored.status === 'completed') throw new Error('Сессия уже завершена')
}
export async function updateSession(session:Session, patch:Partial<Session>, database=db) {
  return database.transaction('rw',[database.sessions,database.outbox],async()=> {
    await assertVersion(session,database)
    const next = {...session,...patch,session_id:session.session_id,version:session.version+1,updated_at:now()}
    await database.sessions.put(next);await enqueue(database,'session',next.session_id,next.user_id,next); return next
  })
}
export async function latestAttempt(question_id:string, database=db):Promise<Attempt|undefined> {
  return (await database.attempts.where('question_id').equals(question_id).toArray()).filter(a=>a.mode!=='exam').sort(compareEvents).at(-1)
}
export async function submitAnswer(session:Session, answer_id:string, is_unsure:boolean, database=db) {
  if(session.mode==='exam')throw new Error('Экзаменационные ответы проверяются после завершения')
  const question_id = currentId(session)
  return database.transaction('rw',[database.sessions,database.questions,database.attempts,database.flags,database.outbox],async()=> {
    await assertVersion(session,database)
    const q = await database.questions.get(question_id)
    const a = q?.answers.find(a=>a.answer_id===answer_id)
    if (!q || !a) throw new Error('Ответ не принадлежит вопросу')
    const previous = await latestAttempt(question_id,database)
    if (previous && !session.retry_ids.includes(question_id)) throw new Error('Для новой попытки нажмите «Ответить заново»')
    const attempt:Attempt = {attempt_id:crypto.randomUUID(),user_id:session.user_id,device_id:session.device_id,
      question_id,answer_id,is_correct:a.is_correct,is_unsure,answered_at:now(),session_id:session.session_id,mode:session.mode}
    await database.attempts.add(attempt)
    await enqueue(database,'attempt',attempt.attempt_id,attempt.user_id,attempt)
    const flag = await database.flags.get(question_id)
    if (flag?.skipped) {const updated={...flag,skipped:false,updated_at:now()};await database.flags.put(updated);await enqueue(database,'flag',updated.question_id,updated.user_id,updated)}
    const next:Session = {...session,choices:{...session.choices,[question_id]:answer_id},
      retry_ids:session.retry_ids.filter(id=>id!==question_id),version:session.version+1,updated_at:now()}
    await database.sessions.put(next)
    await enqueue(database,'session',next.session_id,next.user_id,next)
    return next
  })
}
export async function setUnsure(attempt:Attempt,is_unsure:boolean,database=db) {
  await database.transaction('rw',[database.annotations,database.outbox,database.meta],async()=> {
    const p=await profile(database)
    const previous=await database.annotations.where('attempt_id').equals(attempt.attempt_id).toArray()
    const time=Math.max(Date.now(),...previous.map(a=>Date.parse(a.changed_at)+1))
    const annotation={event_id:crypto.randomUUID(),attempt_id:attempt.attempt_id,user_id:p.id,device_id:p.device_id,is_unsure,changed_at:new Date(time).toISOString()}
    await database.annotations.add(annotation)
    await enqueue(database,'annotation',annotation.event_id,p.id,annotation)
  })
}
export async function setFlag(question_id:string,key:'bookmarked'|'skipped',value:boolean,database=db) {
  await database.transaction('rw',[database.flags,database.outbox,database.meta],async()=> {
    const p=await profile(database)
    const flag = await database.flags.get(question_id) ?? {question_id,user_id:p.id,bookmarked:false,skipped:false,updated_at:now()}
    const updated={...flag,[key]:value,updated_at:now()}
    await database.flags.put(updated)
    await enqueue(database,'flag',question_id,p.id,updated)
  })
}
export async function retryQuestion(session:Session,database=db) {
  if(session.mode==='exam')throw new Error('Начните новый пробный экзамен')
  const id = currentId(session)
  const choices = {...session.choices}; delete choices[id]
  const unsure_choices={...session.unsure_choices};delete unsure_choices[id]
  return updateSession(session,{choices,unsure_choices,retry_ids:[...new Set([...session.retry_ids,id])]},database)
}
export async function move(session:Session,cursor:number,database=db) {
  return updateSession(session,{cursor:Math.max(0,Math.min(cursor,session.question_ids.length-1)),inserted_review_id:null},database)
}
export async function resumeSession(session:Session,database=db) {
  const p=await profile(database)
  return database.transaction('rw',[database.sessions,database.meta,database.outbox],async()=> {
    const active=await activeSession(database)
    if(active && active.session_id!==session.session_id && active.status==='active') {const paused:Session={...active,status:'paused',version:active.version+1,updated_at:now()};await database.sessions.put(paused);await enqueue(database,'session',paused.session_id,paused.user_id,paused)}
    const next=await updateSession(session,{status:'active',device_id:p.device_id},database)
    await database.meta.put({key:'activeSession',value:session.session_id})
    await database.meta.delete('remoteActive')
    await enqueue(database,'active','active',session.user_id,{session_id:session.session_id})
    return next
  })
}
