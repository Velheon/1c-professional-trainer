import { useEffect, useRef, useState } from 'react'
import { safeUrl, type Question, type Session } from '../domain/model'
import { chooseExam, examResult, finishExam } from '../study/exam'
import { move } from '../study/service'
import { Illustration, type Run } from './QuestionView'
export default function ExamView({session:s,questions,run,busy,onHome}:{session:Session;questions:Question[];run:Run;busy:boolean;onHome:()=>void}) {
  const [now,setNow]=useState(Date.now)
  const [confirm,setConfirm]=useState(false)
  const timerExpired=useRef(false)
  const card=useRef<HTMLElement>(null)
  const first=useRef<HTMLButtonElement>(null)
  const next=useRef<HTMLButtonElement>(null)
  const keyboard=useRef(false)
  const remaining=Math.max(0,Math.ceil((Date.parse(s.exam!.deadline_at)-now)/1000))
  const completed=s.status==='completed'
  useEffect(()=> {const timer=setInterval(()=>setNow(Date.now()),500);return ()=>clearInterval(timer)},[])
  useEffect(()=> {
    if(!completed&&remaining===0&&!busy&&!timerExpired.current) {
      timerExpired.current=true
      run(async()=>{try{await finishExam(s.session_id)}finally{timerExpired.current=false}})
    }
  },[remaining,completed,busy,run,s.session_id])
  useEffect(()=> {card.current?.scrollIntoView({block:'start'});if(keyboard.current)first.current?.focus()},[s.cursor])
  useEffect(()=> {if(!busy&&keyboard.current&&s.choices[s.question_ids[s.cursor]])next.current?.focus()},[busy,s.choices,s.cursor,s.question_ids])
  const q=questions.find(q=>q.question_id===s.question_ids[s.cursor])!
  if(completed) {
    const result=examResult(s,questions)
    return <section className="exam-results"><div className="study-bar"><button onClick={onHome}>← Все разделы</button><span>Результат пробного экзамена</span></div>
      <div className="question-card"><h1>{result.passed?'Сдано':'Не сдано'}</h1><p className="lead">Правильных ответов: {result.correct} из {result.total}</p><p>Без ответа: {result.total-result.answered}. Порог: 12. Результат не меняет учебную статистику и расписание повторений.</p></div>
      {s.question_ids.map((id,i)=> {
        const question=questions.find(q=>q.question_id===id)!,selected=s.choices[id],correct=question.answers.find(a=>a.is_correct)!,url=safeUrl(question.explanation_url)
        return <details className="exam-review question-card" key={id}><summary>{i+1}. {selected===correct.answer_id?'✓ Верно':selected?'× Ошибка':'— Без ответа'} · Раздел {question.section_order}, вопрос {question.question_order}</summary>
          <h2 className="question-text">{question.text}</h2>{question.image_pngs.map(path=><Illustration key={path} path={path}/>)}
          <ol>{question.answers.map(a=><li key={a.answer_id} className={a.is_correct?'exam-correct':''}>{a.text}{a.is_correct?' · Верный ответ':''}{a.answer_id===selected?' · Ваш выбор':''}</li>)}</ol>
          <h3>Пояснение</h3><p className="preserve">{question.explanation||(url?'Пояснение в источнике':'В источнике нет пояснения.')}</p>{url&&<a href={url} target="_blank" rel="noopener noreferrer">Открыть пояснение в источнике ↗</a>}
        </details>
      })}
    </section>
  }
  return <><nav className="study-bar"><button onClick={onHome}>← Все разделы</button><span>Пробный экзамен · {s.cursor+1} / 14</span><strong className={remaining<300?'exam-time urgent':'exam-time'} role="timer" aria-label="Осталось времени">{Math.floor(remaining/60)}:{String(remaining%60).padStart(2,'0')}</strong></nav>
    <p className="muted small">Таймер идёт и после закрытия страницы. Выбор можно изменить до завершения. Ключи и пояснения скрыты.</p>
    <div className="study-layout"><article className="question-card" ref={card} aria-labelledby="question-title">
      <div className="eyebrow">Раздел {q.section_order} · Вопрос {q.question_order}</div><h2 id="question-title" className="question-text">{q.text}</h2>
      {q.image_pngs.map(path=><Illustration key={path} path={path}/>)}
      <div className="answers" role="group" aria-label="Варианты ответа">{q.answers.map((a,i)=><button ref={i===0?first:undefined} key={a.answer_id} className="answer" aria-pressed={s.choices[q.question_id]===a.answer_id} disabled={busy||remaining===0}
        onKeyDown={e=>{if(e.repeat&&(e.key==='Enter'||e.key===' '))e.preventDefault()}}
        onClick={e=>{keyboard.current=e.detail===0;run(()=>chooseExam(s,a.answer_id))}}><span className="answer-indicator" aria-hidden="true">{s.choices[q.question_id]===a.answer_id?'●':'○'}</span><span className="answer-number">{a.answer_order}</span><span className="answer-text">{a.text}</span></button>)}</div>
      <div className="study-dock"><span className="dock-hint">{s.choices[q.question_id]?'Выбор сохранён':'Можно пропустить и вернуться'}</span><button ref={next} className="primary" disabled={busy||remaining===0} onKeyDown={e=>{if(e.repeat&&(e.key==='Enter'||e.key===' '))e.preventDefault()}} onClick={()=>{keyboard.current=document.activeElement===next.current;run(()=>move(s,(s.cursor+1)%s.question_ids.length))}}>Следующий вопрос <span aria-hidden="true">→</span></button></div>
      <div className="bottom-nav"><button disabled={busy||s.cursor===0} onClick={()=>run(()=>move(s,s.cursor-1))}>← Назад</button></div>
    </article><aside className="navigator"><h3>Ответов: {Object.keys(s.choices).length} / 14</h3><div className="question-grid">{s.question_ids.map((id,i)=><button key={id} className={i===s.cursor?'current':''} aria-label={`Вопрос ${i+1}, ${s.choices[id]?'выбран ответ':'без ответа'}`} aria-current={i===s.cursor?'step':undefined} disabled={busy} onClick={()=>run(()=>move(s,i))}>{i+1}{s.choices[id]&&<span className="tiny">●</span>}</button>)}</div>
      <button disabled={busy} onClick={()=>setConfirm(true)}>Завершить экзамен</button>
      {confirm&&<div className="exam-confirm" role="group" aria-label="Подтверждение завершения"><p>Завершить сейчас? Без ответа: {14-Object.keys(s.choices).length}. Изменить выбор после этого нельзя.</p><button className="primary" disabled={busy} onClick={()=>run(()=>finishExam(s.session_id))}>Завершить и показать результат</button><button disabled={busy} onClick={()=>setConfirm(false)}>Продолжить экзамен</button></div>}
    </aside></div>
  </>
}
