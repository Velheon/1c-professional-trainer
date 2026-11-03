import { z } from 'zod'
import { db, profile, type TrainerDB } from '../storage/db'
import { annotationSchema, attemptSchema, canonical, sessionSchema, type Binding } from '../sync/model'
import { enqueue } from '../sync/queue'
import type { ImportReport, Profile } from '../domain/model'

const flagSchema=z.object({question_id:z.uuid(),user_id:z.uuid(),bookmarked:z.boolean(),skipped:z.boolean(),updated_at:z.iso.datetime({offset:true})}).strict()
export const backupSchema=z.object({
  format:z.literal('1c-trainer-history'),version:z.literal(1),created_at:z.iso.datetime({offset:true}),
  user_id:z.uuid(),project_url:z.string().nullable(),bank_sha256:z.string(),
  attempts:z.array(attemptSchema.strict()).max(200_000),annotations:z.array(annotationSchema.strict()).max(200_000),
  sessions:z.array(sessionSchema).max(20_000),flags:z.array(flagSchema).max(20_000),
  preferences:z.object({theme:z.enum(['dark','light','system'])}).strict(),
}).strict()
export type HistoryBackup=z.infer<typeof backupSchema>
export type RestorePolicy='keep'|'restore'
export const MAX_BACKUP_BYTES=50*1024*1024
const tables=(database:TrainerDB)=>[database.meta,database.attempts,database.annotations,database.sessions,database.flags,database.questions,database.sections,database.outbox,database.syncHeads]

export async function exportHistory(database=db):Promise<HistoryBackup> {
  await profile(database)
  return database.transaction('r',tables(database),async()=> {
    const p=(await database.meta.get('profile'))!.value as Profile
    const binding=(await database.meta.get('cloudBinding'))?.value as Binding|undefined
    return backupSchema.parse({format:'1c-trainer-history',version:1,created_at:new Date().toISOString(),user_id:p.id,project_url:binding?.project_url??null,
      bank_sha256:((await database.meta.get('import'))?.value as ImportReport|undefined)?.sha256??'',
      attempts:await database.attempts.toArray(),annotations:await database.annotations.toArray(),sessions:await database.sessions.toArray(),flags:await database.flags.toArray(),
      preferences:{theme:(await database.meta.get('theme'))?.value??'dark'},
    })
  })
}
export function parseBackup(text:string):HistoryBackup {
  if(new TextEncoder().encode(text).byteLength>MAX_BACKUP_BYTES)throw new Error('Размер копии превышает 50 МБ')
  try{return backupSchema.parse(JSON.parse(text))}catch{throw new Error('Это не поддерживаемая резервная копия истории (нужен формат версии 1).')}
}
async function inspect(backup:HistoryBackup,database:TrainerDB) {
  const p=(await database.meta.get('profile'))?.value as Profile|undefined
  const binding=(await database.meta.get('cloudBinding'))?.value as Binding|undefined
  if(binding&&(binding.signed_out||binding.user_id!==backup.user_id||binding.project_url!==backup.project_url))throw new Error('Копия принадлежит другому аккаунту или проекту. Войдите в исходный аккаунт.')
  if(p&&p.id!==backup.user_id&&(await database.attempts.count()||await database.sessions.count()||await database.flags.count()||await database.annotations.count()))throw new Error('Местная история принадлежит другому профилю. Объедините устройства через один облачный аккаунт.')
  const report=(await database.meta.get('import'))?.value as ImportReport|undefined
  if(!report||report.sha256!==backup.bank_sha256)throw new Error('Сначала загрузите тот же банк вопросов, из которого сделана копия.')
  const questions=new Map((await database.questions.toArray()).map(q=>[q.question_id,q]))
  const attempts=new Map((await database.attempts.toArray()).map(a=>[a.attempt_id,a]))
  const annotations=new Map((await database.annotations.toArray()).map(a=>[a.event_id,a]))
  const checkOwner=(value:{user_id:string})=> {if(value.user_id!==backup.user_id)throw new Error('В копии смешаны данные разных владельцев')}
  const unique=(ids:string[])=> {if(new Set(ids).size!==ids.length)throw new Error('В копии повторяются UUID')}
  unique(backup.attempts.map(a=>a.attempt_id));unique(backup.annotations.map(a=>a.event_id));unique(backup.sessions.map(s=>s.session_id));unique(backup.flags.map(f=>f.question_id))
  let newAttempts=0,newAnnotations=0,sessionConflicts=0,flagConflicts=0
  for(const a of backup.attempts) {
    checkOwner(a)
    const answer=questions.get(a.question_id)?.answers.find(x=>x.answer_id===a.answer_id)
    if(!answer||answer.is_correct!==a.is_correct)throw new Error('Попытка не соответствует вопросу или ключу ответа')
    const old=attempts.get(a.attempt_id)
    if(old&&canonical(old)!==canonical(a))throw new Error('Совпавший UUID попытки содержит разные данные. Импорт отменён.')
    if(!old)newAttempts++
    attempts.set(a.attempt_id,a)
  }
  for(const a of backup.annotations) {
    checkOwner(a)
    if(attempts.get(a.attempt_id)?.user_id!==backup.user_id)throw new Error('Для отметки уверенности не найдена попытка')
    const old=annotations.get(a.event_id)
    if(old&&canonical(old)!==canonical(a))throw new Error('Совпавший UUID отметки содержит разные данные. Импорт отменён.')
    if(!old)newAnnotations++
  }
  let newSessions=0,newFlags=0
  for(const s of backup.sessions) {
    checkOwner(s)
    const ids=[...s.question_ids,...(s.inserted_review_id?[s.inserted_review_id]:[])]
    if(ids.some(id=>!questions.has(id))||s.section_id&&!await database.sections.get(s.section_id)||s.retry_ids.some(id=>!ids.includes(id)))throw new Error('В сессии неизвестный вопрос или раздел')
    for(const [id,answer] of Object.entries(s.choices))if(!ids.includes(id)||!questions.get(id)?.answers.some(a=>a.answer_id===answer))throw new Error('В сессии неверный вариант ответа')
    const old=await database.sessions.get(s.session_id)
    if(!old)newSessions++
    else if(canonical({...old,version:0})!==canonical({...s,version:0}))sessionConflicts++
  }
  for(const f of backup.flags) {
    checkOwner(f)
    if(!questions.has(f.question_id))throw new Error('В отметках неизвестный вопрос')
    const old=await database.flags.get(f.question_id)
    if(!old)newFlags++
    else if(canonical(old)!==canonical(f))flagConflicts++
  }
  return {newAttempts,existingAttempts:backup.attempts.length-newAttempts,newAnnotations,newSessions,newFlags,sessionConflicts,flagConflicts}
}
export async function previewHistory(backup:HistoryBackup,database=db) {
  const parsed=backupSchema.parse(backup)
  return database.transaction('r',tables(database),()=>inspect(parsed,database))
}
export async function restoreHistory(input:HistoryBackup,policy:RestorePolicy,database=db) {
  const backup=backupSchema.parse(input)
  await profile(database)
  return database.transaction('rw',tables(database),async()=> {
    // Recheck inside the write transaction: edits/sync after the preview cannot evade validation.
    const result=await inspect(backup,database)
    const p=(await database.meta.get('profile'))!.value as Profile
    if(p.id!==backup.user_id) {
      // An empty local profile may adopt a backup, retaining only this device's identity.
      await database.outbox.clear()
      await database.syncHeads.clear()
    }
    await database.meta.put({key:`beforeRestore:${crypto.randomUUID()}`,value:{created_at:new Date().toISOString(),sessions:await database.sessions.toArray(),flags:await database.flags.toArray(),theme:(await database.meta.get('theme'))?.value,policy}})
    await database.meta.put({key:'profile',value:{...p,id:backup.user_id}})
    for(const a of backup.attempts)if(!await database.attempts.get(a.attempt_id)){await database.attempts.add(a);await enqueue(database,'attempt',a.attempt_id,a.user_id,a)}
    for(const a of backup.annotations)if(!await database.annotations.get(a.event_id)){await database.annotations.add(a);await enqueue(database,'annotation',a.event_id,a.user_id,a)}
    for(const s of backup.sessions) {
      const old=await database.sessions.get(s.session_id)
      // A pre-finish backup must never reopen a completed exam under the same ID.
      if(old?.mode==='exam'&&old.status==='completed')continue
      if(old&&(policy==='keep'||canonical({...old,version:0})===canonical({...s,version:0})))continue
      // Imported sessions are resumed explicitly; keep the current active-session pointer.
      const next={...s,status:s.status==='active'?'paused' as const:s.status,version:Math.max(old?.version??0,s.version)+1}
      await database.sessions.put(next);await enqueue(database,'session',next.session_id,next.user_id,next)
    }
    for(const f of backup.flags) {
      const old=await database.flags.get(f.question_id)
      if(old&&(policy==='keep'||canonical(old)===canonical(f)))continue
      await database.flags.put(f);await enqueue(database,'flag',f.question_id,f.user_id,f)
    }
    if(policy==='restore'||!await database.meta.get('theme')||p.id!==backup.user_id) {
      await database.meta.put({key:'theme',value:backup.preferences.theme})
      await enqueue(database,'preferences','theme',backup.user_id,backup.preferences)
    }
    return result
  })
}
