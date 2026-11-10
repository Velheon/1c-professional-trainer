import { classificationSchema } from '../analytics/mechanisms'
import type { Annotation, Attempt, Flag, Session } from '../domain/model'
import type { TrainerDB } from '../storage/db'
import { annotationSchema, attemptSchema, canonical, keyOf, validatePayload, type Binding, type Conflict, type MutableKind, type Outbox, type Payload, type RemoteState } from './model'
export interface SyncTransport {
  attempts():Promise<unknown[]>; annotations():Promise<unknown[]>; states():Promise<RemoteState[]>;
  putImmutable(event:Outbox):Promise<void>;
  putState(event:Outbox,expectedVersion:number):Promise<number>;
  state(kind:MutableKind,id:string):Promise<RemoteState|null>;
}
export async function bindAccount(database:TrainerDB,user_id:string,project_url:string,consent:boolean) {
  return database.transaction('rw',[database.meta,database.attempts,database.annotations,database.sessions,database.flags,database.outbox,database.syncHeads,database.conflicts],async()=> {
    const previous=(await database.meta.get('cloudBinding'))?.value as Binding|undefined
    if(previous && (previous.user_id!==user_id||previous.project_url!==project_url))throw new Error('Это хранилище привязано к другому аккаунту или проекту. История не смешана.')
    if(previous) {await database.meta.put({key:'cloudBinding',value:{...previous,signed_out:false}});return}
    if(!consent)throw new Error('Подтвердите перенос локальной истории в личный аккаунт')
    const attempts=await database.attempts.toArray(),annotations=await database.annotations.toArray(),sessions=await database.sessions.toArray(),flags=await database.flags.toArray()
    const p=(await database.meta.get('profile'))?.value as {id:string;device_id:string}|undefined
    const device_id=p?.device_id??crypto.randomUUID()
    await database.meta.put({key:'beforeCloudBinding',value:{attempts,annotations,sessions,flags,profile:p,created_at:new Date().toISOString()}})
    // Explicit owner transfer only. UUIDs, outcomes, answers and timestamps stay intact.
    const ownedAttempts=attempts.map(a=>({...a,user_id}))
    const ownedAnnotations=annotations.map(a=>({...a,user_id}))
    const ownedSessions=sessions.map(s=>({...s,user_id,version:s.version+1}))
    const ownedFlags=flags.map(f=>({...f,user_id}))
    await database.attempts.bulkPut(ownedAttempts)
    await database.annotations.bulkPut(ownedAnnotations)
    await database.sessions.bulkPut(ownedSessions)
    await database.flags.bulkPut(ownedFlags)
    await database.meta.put({key:'profile',value:{id:user_id,device_id}})
    await database.meta.put({key:'cloudBinding',value:{user_id,project_url,signed_out:false}})
    await database.outbox.clear()
    const add=async(kind:Outbox['kind'],id:string,payload:Payload)=>database.outbox.put({key:keyOf(kind,id),kind,entity_id:id,payload:{...payload,...('user_id' in payload?{user_id}:{})},event_id:crypto.randomUUID(),user_id,created_at:new Date().toISOString()})
    for(const a of ownedAttempts)await add('attempt',a.attempt_id,a)
    for(const a of ownedAnnotations)await add('annotation',a.event_id,a)
    for(const s of ownedSessions)await add('session',s.session_id,s)
    for(const f of ownedFlags)await add('flag',f.question_id,f)
    for(const row of await database.meta.where('key').startsWith('classification:').toArray()) {
      await add('classification',row.key.slice('classification:'.length),classificationSchema.parse(row.value))
    }
    const active=(await database.meta.get('activeSession'))?.value
    if(typeof active==='string')await add('active','active',{session_id:active})
    const theme=(await database.meta.get('theme'))?.value
    if(theme==='dark'||theme==='light'||theme==='system')await add('preferences','theme',{theme})
  })
}
export async function mergeHistory(database:TrainerDB,user_id:string,attempts:unknown[],annotations:unknown[]) {
  const parsedAttempts=attempts.map(a=>attemptSchema.parse(a)),parsedAnnotations=annotations.map(a=>annotationSchema.parse(a))
  await database.transaction('rw',[database.attempts,database.annotations,database.questions],async()=> {
    for(const a of parsedAttempts) {
      if(a.user_id!==user_id)throw new Error('Сервер вернул чужую историю')
      const old=await database.attempts.get(a.attempt_id)
      if(old) {if(canonical(old)!==canonical(a))throw new Error('Конфликт неизменяемой попытки');continue}
      const q=await database.questions.get(a.question_id),answer=q?.answers.find(x=>x.answer_id===a.answer_id)
      if(!answer||answer.is_correct!==a.is_correct)throw new Error('История не соответствует банку вопросов')
      await database.attempts.add(a)
    }
    for(const a of parsedAnnotations) {
      if(a.user_id!==user_id)throw new Error('Сервер вернул чужую отметку уверенности')
      const attempt=await database.attempts.get(a.attempt_id)
      if(!attempt||attempt.user_id!==user_id)throw new Error('Нет попытки для отметки уверенности')
      const old=await database.annotations.get(a.event_id)
      if(old) {if(canonical(old)!==canonical(a))throw new Error('Конфликт неизменяемого события');continue}
      await database.annotations.add(a)
    }
  })
}
async function applyPayload(database:TrainerDB,remote:RemoteState) {
  const p=validatePayload(remote.kind,remote.payload)
  if(remote.kind==='session') {
    const s=p as Session
    if(s.user_id!==remote.user_id||s.session_id!==remote.entity_id)throw new Error('Некорректный владелец сессии')
    for(const id of [...s.question_ids,...(s.inserted_review_id?[s.inserted_review_id]:[])])if(!await database.questions.get(id))throw new Error('В сессии неизвестный вопрос')
    const old=await database.sessions.get(s.session_id)
    await database.sessions.put({...s,version:Math.max(s.version,old?.version??0)+1})
    const profile=(await database.meta.get('profile'))?.value as {device_id:string}|undefined
    if(s.status==='active'&&s.device_id!==profile?.device_id&&(await database.meta.get('activeSession'))?.value===s.session_id) {
      await database.meta.put({key:'remoteActive',value:s.session_id})
      await database.meta.put({key:'activeSession',value:null})
    }
  } else if(remote.kind==='flag') {
    const f=p as Flag
    if(f.user_id!==remote.user_id||f.question_id!==remote.entity_id||!await database.questions.get(f.question_id))throw new Error('Некорректная отметка вопроса')
    await database.flags.put(f)
  } else if(remote.kind==='classification') {
    if(!await database.questions.get(remote.entity_id))throw new Error('Не найден вопрос для классификации')
    await database.meta.put({key:keyOf('classification',remote.entity_id),value:p})
  } else if(remote.kind==='preferences') {
    await database.meta.put({key:'theme',value:(p as {theme:string}).theme})
  } else {
    const id=(p as {session_id:string|null}).session_id
    const s=id?await database.sessions.get(id):undefined
    const profile=(await database.meta.get('profile'))?.value as {device_id:string}|undefined
    if(id&&!s)throw new Error('Не найдена активная сессия')
    if(s && s.device_id!==profile?.device_id && s.status!=='completed') {
      await database.meta.put({key:'remoteActive',value:id})
    } else {
      await database.meta.put({key:'activeSession',value:id})
      await database.meta.delete('remoteActive')
    }
  }
}
const mutableTables=(database:TrainerDB)=>[database.outbox,database.syncHeads,database.conflicts,database.sessions,database.flags,database.meta,database.questions]
async function acknowledge(database:TrainerDB,event:Outbox,version?:number) {
  await database.transaction('rw',[database.outbox,database.syncHeads],async()=> {
    const previous=await database.syncHeads.get(event.key)
    if(version!==undefined && version>=(previous?.version??0))await database.syncHeads.put({key:event.key,version,event_id:event.event_id})
    if((await database.outbox.get(event.key))?.event_id===event.event_id)await database.outbox.delete(event.key)
  })
}
export async function mergeState(database:TrainerDB,user_id:string,remote:RemoteState) {
  if(remote.user_id!==user_id)throw new Error('Сервер вернул чужую сессию')
  if(!Number.isSafeInteger(remote.version)||remote.version<1)throw new Error('Некорректная версия сервера')
  remote={...remote,payload:validatePayload(remote.kind,remote.payload)}
  const key=keyOf(remote.kind,remote.entity_id)
  await database.transaction('rw',mutableTables(database),async()=> {
    const head=await database.syncHeads.get(key),pending=await database.outbox.get(key)
    if(head && remote.version<head.version)return
    if(head && remote.version===head.version) {
      if(head.event_id!==remote.event_id)throw new Error('Сервер изменил событие без новой версии')
      return
    }
    if(pending) {
      if(canonical(pending.payload)===canonical(remote.payload)) {
        await database.syncHeads.put({key,version:remote.version,event_id:remote.event_id})
        await database.outbox.delete(key);await database.conflicts.delete(key)
      } else {
        await database.conflicts.put({key,local:pending,remote,detected_at:new Date().toISOString()})
      }
    } else {
      await applyPayload(database,remote)
      await database.syncHeads.put({key,version:remote.version,event_id:remote.event_id})
      await database.conflicts.delete(key)
    }
  })
}
export async function resolveConflict(database:TrainerDB,conflict:Conflict,choice:'local'|'remote') {
  await database.transaction('rw',mutableTables(database),async()=> {
    const pending=await database.outbox.get(conflict.key),current=await database.conflicts.get(conflict.key)
    if(!pending||pending.event_id!==conflict.local.event_id||current?.remote.version!==conflict.remote.version)throw new Error('Состояние изменилось. Обновите выбор конфликта.')
    await database.meta.put({key:`resolvedConflict:${crypto.randomUUID()}`,value:{...conflict,choice,resolved_at:new Date().toISOString()}})
    await database.syncHeads.put({key:conflict.key,version:conflict.remote.version,event_id:conflict.remote.event_id})
    if(choice==='remote') {await applyPayload(database,conflict.remote);await database.outbox.delete(conflict.key)}
    await database.conflicts.delete(conflict.key)
  })
}
const priorities:Record<Outbox['kind'],number>={attempt:0,annotation:1,session:2,flag:3,preferences:4,active:5,classification:6}
const running=new WeakSet<TrainerDB>()
export async function synchronize(database:TrainerDB,user_id:string,transport:SyncTransport) {
  if(running.has(database))return
  running.add(database)
  try {
    await mergeHistory(database,user_id,await transport.attempts(),await transport.annotations())
    const states=await transport.states()
    for(const remote of states.sort((a,b)=>(a.kind==='active'?1:0)-(b.kind==='active'?1:0)))await mergeState(database,user_id,remote)
    const events=(await database.outbox.toArray()).sort((a,b)=>priorities[a.kind]-priorities[b.kind]||a.created_at.localeCompare(b.created_at))
    for(const event of events) {
      if(event.user_id!==user_id)throw new Error('Очередь принадлежит другому пользователю')
      if(event.kind==='attempt'||event.kind==='annotation') {await transport.putImmutable(event);await acknowledge(database,event);continue}
      if(await database.conflicts.get(event.key))continue
      const head=await database.syncHeads.get(event.key)
      try {
        const version=await transport.putState(event,head?.version??0)
        await acknowledge(database,event,version)
      } catch(error) {
        // Also recover a successful write whose response was lost in transit.
        const remote=await transport.state(event.kind,event.entity_id)
        if(!remote)throw error
        if(remote.event_id===event.event_id && canonical(remote.payload)===canonical(event.payload))await acknowledge(database,event,remote.version)
        else if(remote.version>(head?.version??0))await mergeState(database,user_id,remote)
        else throw error
      }
    }
  } finally {running.delete(database)}
}
export type { Attempt, Annotation }
