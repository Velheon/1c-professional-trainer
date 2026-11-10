import { useState } from 'react'
import { mechanismById, mechanisms, type Classification } from '../analytics/mechanisms'
import { saveClassification } from '../analytics/classification'
import type { Attempt } from '../domain/model'
import type { Run } from './QuestionView'

const modes={sequential:'Изучение',random:'Случайная тренировка',review:'Повторение',exam:'Экзамен'}

export function AttemptHistory({attempts}:{attempts:Attempt[]}) {
  const [limit,setLimit]=useState(15)
  if(!attempts.length)return null
  return <details className="question-details">
    <summary>История ответов ({attempts.length})</summary>
    <ul className="attempt-list">
      {attempts.slice(-limit).reverse().map(a=><li key={a.attempt_id}>
        <time dateTime={a.answered_at}>{new Date(a.answered_at).toLocaleString('ru-RU')}</time>
        <span>{modes[a.mode]}</span><strong>{a.is_correct?'Верно':'Ошибка'}</strong>
      </li>)}
    </ul>
    {attempts.length>limit&&<button onClick={()=>setLimit(n=>n+15)}>Ещё попытки</button>}
  </details>
}

export function MechanismEditor({questionId,value,run,busy}:{questionId:string;value:Classification;run:Run;busy:boolean}) {
  const [editing,setEditing]=useState(false)
  const [primary,setPrimary]=useState(value.primary)
  const [additional,setAdditional]=useState(value.additional)
  function start() {
    setPrimary(value.primary);setAdditional(value.additional);setEditing(true)
  }
  return <details className="question-details">
    <summary>Механизмы 1С</summary>
    <p><strong>{mechanismById.get(value.primary)?.title}</strong>{value.additional.length>0&&
      <span> · {value.additional.map(id=>mechanismById.get(id)?.title).join(', ')}</span>}</p>
    {editing?<form onSubmit={event=>{
      event.preventDefault()
      run(async()=>{await saveClassification(questionId,{primary,additional});setEditing(false)})
    }}>
      <label>Основной механизм<select aria-label="Основной механизм" value={primary} onChange={event=>{
        setPrimary(event.target.value);setAdditional(ids=>ids.filter(id=>id!==event.target.value))
      }}>
        {mechanisms.map(m=><option key={m.id} value={m.id}>{m.title}</option>)}
      </select></label>
      <fieldset className="mechanism-options"><legend>Дополнительные механизмы</legend>
        {mechanisms.filter(m=>m.id!==primary).map(m=><label key={m.id}>
          <input type="checkbox" checked={additional.includes(m.id)} disabled={busy||additional.length>=10&&!additional.includes(m.id)}
            onChange={event=>setAdditional(ids=>event.target.checked?[...ids,m.id]:ids.filter(id=>id!==m.id))}/>
          {m.title}
        </label>)}
      </fieldset>
      <div className="actions"><button className="primary" disabled={busy}>Сохранить теги</button>
        <button type="button" onClick={()=>setEditing(false)}>Отмена</button></div>
    </form>:<button onClick={start}>Изменить теги</button>}
  </details>
}
