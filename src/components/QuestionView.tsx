import { useEffect, useRef, useState } from 'react'
import { db } from '../storage/db'
import { safeUrl, type Annotation, type Attempt, type Flag, type Question, type Session } from '../domain/model'
import { currentId, effectiveUnsure, move, retryQuestion, setFlag, setUnsure, submitAnswer, updateSession } from '../study/service'
export type Run = (work:()=>Promise<unknown>)=>void
function ImageDialog({url,close}:{url:string;close:()=>void}) {
  const dialog=useRef<HTMLDialogElement>(null)
  useEffect(()=> {dialog.current?.showModal()},[])
  return <dialog ref={dialog} className="draft-dialog image-modal" onClose={close} onCancel={close} aria-label="Иллюстрация"><button autoFocus onClick={close}>Закрыть</button><img src={url} alt="Увеличенная иллюстрация к вопросу"/></dialog>
}
export function Illustration({path}: {path:string}) {
  const [url,setUrl] = useState('')
  const [large,setLarge] = useState(false)
  useEffect(()=> {
    let disposed = false, resource = ''
    void db.images.get(path).then(image=> {
      if (image && !disposed) { resource=URL.createObjectURL(image.blob); setUrl(resource) }
    })
    return ()=> {disposed=true; if(resource) URL.revokeObjectURL(resource)}
  },[path])
  if (!url) return <p role="status">Загрузка иллюстрации…</p>
  return <><button className="illustration" onClick={()=>setLarge(true)} aria-label="Увеличить иллюстрацию"><img src={url} alt="Иллюстрация к вопросу"/></button>
    {large && <ImageDialog url={url} close={()=>setLarge(false)}/>}</>
}
export default function QuestionView({question:q,session,attempt,annotations,flag,run,busy,onNext,onChat,keyboardInput=false}: {
  question:Question; session:Session; attempt?:Attempt; annotations:Annotation[]; flag?:Flag; run:Run; busy:boolean;
  onNext?:()=>Promise<unknown>; onChat?:()=>void; keyboardInput?:boolean;
}) {
  const article=useRef<HTMLElement>(null)
  const scrollOnMount=useRef(!keyboardInput)
  useEffect(()=> {if(scrollOnMount.current)article.current?.scrollIntoView({block:'start'})},[])
  const firstAnswer=useRef<HTMLButtonElement>(null)
  const nextButton=useRef<HTMLButtonElement>(null)
  const focusOnMount=useRef(keyboardInput)
  const focusAfterAnswer=useRef(false)
  const id=currentId(session)
  const viewing=!!attempt && !session.retry_ids.includes(id)
  const [localSelected,setLocalSelected]=useState(session.choices[id])
  const selected=viewing ? attempt.answer_id : localSelected
  const unsure=viewing ? effectiveUnsure(attempt,annotations) : false
  const [draftUnsure,setDraftUnsure]=useState(session.unsure_choices?.[id]??false)
  const url=safeUrl(q.explanation_url)
  const choose=async(answer_id:string)=> {
    setLocalSelected(answer_id)
    try { return await submitAnswer(session,answer_id,draftUnsure) }
    catch(e) {setLocalSelected(session.choices[id]);throw e}
  }
  useEffect(()=> {
    if(busy) return
    if(viewing && focusAfterAnswer.current) {focusAfterAnswer.current=false;nextButton.current?.focus()}
    else if(focusOnMount.current) {
      focusOnMount.current=false
      if(viewing) nextButton.current?.focus()
      else firstAnswer.current?.focus()
    }
  },[viewing,busy])
  const next=()=>onNext ? onNext() : move(session,session.cursor+1)
  useEffect(()=> {
    function key(e:KeyboardEvent) {
      const target=e.target instanceof Element?e.target:null
      const answerFocused=!!target?.closest('button.answer')
      if(e.repeat || e.altKey || e.ctrlKey || e.metaKey || e.isComposing || busy || target?.closest('input,textarea,select,a,[contenteditable],dialog,[role="dialog"]') || (!answerFocused&&target?.closest('button'))) return
      const n=Number(e.key)
      const numbered=q.answers.find(a=>a.answer_code===n)
      if(!viewing && !!numbered) {e.preventDefault();focusAfterAnswer.current=true;run(()=>choose(numbered!.answer_id))}
      if(answerFocused)return // Let native Enter/Space activate the focused answer.
      if(e.key==='Enter') {e.preventDefault(); if(viewing) run(next)}
      if(e.key==='ArrowRight' && session.cursor<session.question_ids.length-1) {e.preventDefault();run(()=>move(session,session.cursor+1))}
      if(e.key==='ArrowLeft' && session.cursor>0) {e.preventDefault();run(()=>move(session,session.cursor-1))}
    }
    document.addEventListener('keydown',key);return ()=>document.removeEventListener('keydown',key)
  })
  return <article ref={article} className="question-card" aria-labelledby="question-title">
    <div className="eyebrow">{session.inserted_review_id ? 'Повторение · ' : ''}Раздел {q.section_order} · Вопрос {q.question_order}</div>
    <div className="question-top"><h2 id="question-title" className="question-text">{q.text}</h2><button className={flag?.bookmarked?'star active':'star'} disabled={busy} onClick={()=>run(()=>setFlag(id,'bookmarked',!flag?.bookmarked))} aria-label={flag?.bookmarked?'Убрать закладку':'Добавить закладку'} aria-pressed={!!flag?.bookmarked}>{flag?.bookmarked?'★':'☆'}</button></div>
    {q.image_pngs.map(path=><Illustration key={path} path={path}/>)}
    <p className="muted small">{viewing?'Ответ сохранён. Для новой попытки нажмите «Ответить заново».':'Выбор варианта сразу сохраняет ответ и показывает пояснение.'}</p>
    <p className="muted small">Номера вариантов — исходные коды. Ссылки «варианты 1 и 2» относятся к этим номерам.</p>
    <div className="answers" role="group" aria-label="Варианты ответа">
      {q.answers.map((a,i)=><button type="button" key={a.answer_id} ref={i===0?firstAnswer:undefined}
        className={`answer ${viewing && a.is_correct?'correct':''} ${viewing && selected===a.answer_id && !a.is_correct?'incorrect':''}`}
        value={a.answer_id} aria-pressed={selected===a.answer_id} disabled={viewing||busy}
        onKeyDown={e=> {if(e.key==='Enter'||e.key===' ') {if(e.repeat)e.preventDefault();else focusAfterAnswer.current=true}}}
        onClick={e=> {if(e.detail===0)focusAfterAnswer.current=true;run(()=>choose(a.answer_id))}}>
        <span className="answer-indicator" aria-hidden="true">{selected===a.answer_id?'●':'○'}</span>
        <span className="answer-number">{a.answer_code}</span><span className="answer-text">{a.text}</span>{viewing && a.is_correct && <span className="answer-mark">✓ Верный</span>}{viewing && selected===a.answer_id && !a.is_correct && <span className="answer-mark">Ваш ответ</span>}
      </button>)}
    </div>
    <label className="check"><input type="checkbox" checked={viewing?unsure:draftUnsure} disabled={busy} onChange={e=> {const checked=e.target.checked;if(viewing)run(()=>setUnsure(attempt,checked));else {setDraftUnsure(checked);run(()=>updateSession(session,{unsure_choices:{...session.unsure_choices,[id]:checked}}))}}}/>Ответил наугад / Не уверен <span className="muted">необязательно</span></label>
    {!viewing && <div className="actions"><button disabled={busy} onClick={()=>run(async()=> {await setFlag(id,'skipped',true);await next()})}>Пропустить</button>{onChat && <button className="subtle" onClick={onChat}>Разобрать с ChatGPT</button>}</div>}
    <div className="study-dock" data-ready={viewing} aria-label="Переход к следующему вопросу">
      <span className="dock-hint">{viewing?'Ответ сохранён':'Сначала выберите ответ'}</span>
      <button ref={nextButton} type="button" className="primary" disabled={busy||!viewing}
        onKeyDown={e=> {if(e.repeat&&(e.key==='Enter'||e.key===' '))e.preventDefault()}}
        onClick={()=>run(next)}>Следующий вопрос <span aria-hidden="true">→</span></button>
    </div>
    {viewing && <section className={`explanation ${attempt.is_correct?'success':'error-result'}`} aria-label="Результат ответа" aria-live="polite">
      <h3>{attempt.is_correct?'✓ Верно':'Попробуем разобраться'}</h3>
      {!attempt.is_correct && <p>Правильный вариант: {q.answers.find(a=>a.is_correct)?.answer_code}.</p>}
      {!attempt.is_correct&&<p>Требует повторения</p>}<h4>Пояснение</h4><p className="preserve">{q.explanation || (url?'Пояснение в источнике':'В источнике нет пояснения.')}</p>
      {url && <a href={url} target="_blank" rel="noopener noreferrer">Открыть пояснение в источнике ↗</a>}
      <div className="actions"><button disabled={busy} onClick={()=>run(()=>retryQuestion(session))}>Ответить заново</button>{onChat && <button onClick={onChat}>Разобрать с ChatGPT</button>}</div>
      <p className="muted small">Просмотр последнего ответа · {new Date(attempt.answered_at).toLocaleString('ru-RU')}</p>
    </section>}
    <footer className="question-footer"><span>Код вопроса {q.question_code}</span><details><summary>Идентификатор</summary><code>{q.question_id}</code></details></footer>
  </article>
}
