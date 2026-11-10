import { useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import type { Flag, Session } from '../domain/model'
import type { Conflict, MutableKind, Payload } from '../sync/model'
import { db } from '../storage/db'
import { mechanismById, type Classification } from '../analytics/mechanisms'
const modes={sequential:'Изучение раздела',random:'Случайная тренировка',review:'Повторение',exam:'Экзамен'}
function sessionText(s?:Session){return s?`${modes[s.mode]} · вопрос ${s.cursor+1} из ${s.question_ids.length} · ${s.status==='completed'?'завершена':s.status==='paused'?'приостановлена':'активна'}`:'Нет активной тренировки'}
function simpleVersion(kind:MutableKind,payload:Payload){
  if(kind==='classification'){
    const value=payload as Classification
    return [value.primary,...value.additional].map(id=>mechanismById.get(id)?.title??id).join(' · ')
  }
  if(kind==='session')return sessionText(payload as Session)
  if(kind==='flag'){const f=payload as Flag;return `Закладка: ${f.bookmarked?'да':'нет'}. Пропущен: ${f.skipped?'да':'нет'}.`}
  if(kind==='preferences'){const theme=(payload as {theme:string}).theme;return `Тема: ${theme==='dark'?'тёмная':theme==='light'?'светлая':'системная'}`}
  return ''
}
export default function ConflictCard({conflict:c,resolve}:{conflict:Conflict;resolve:(choice:'local'|'remote')=>Promise<void>}){
  const [busy,setBusy]=useState(false)
  const active=useLiveQuery(async()=> {
    if(c.local.kind!=='active')return null
    const local=(c.local.payload as {session_id:string|null}).session_id,remote=(c.remote.payload as {session_id:string|null}).session_id
    return {local:local?await db.sessions.get(local):undefined,remote:remote?await db.sessions.get(remote):undefined}
  },[c.key,c.local.event_id,c.remote.event_id])
  const kind=c.remote.kind
  return <section><p>Изменения на устройствах разошлись: {kind==='session'?'учебная сессия':kind==='active'?'активная тренировка':kind==='flag'?'отметки вопроса':kind==='classification'?'теги вопроса':'оформление'}. История ответов сохранена с обеих сторон.</p>
    <dl className="conflict-comparison"><dt>На этом устройстве</dt><dd>{kind==='active'?sessionText(active?.local):simpleVersion(kind,c.local.payload)}</dd><dt>В облаке</dt><dd>{kind==='active'?sessionText(active?.remote):simpleVersion(kind,c.remote.payload)}</dd></dl>
    <div className="actions">{(['local','remote'] as const).map(choice=><button key={choice} disabled={busy} onClick={()=>{setBusy(true);void resolve(choice).finally(()=>setBusy(false))}}>{choice==='local'?'Сохранить местную версию':'Использовать облачную версию'}</button>)}</div>
  </section>
}
