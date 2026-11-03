import { useEffect, useRef, useState } from 'react'
import type { Question, Section } from '../domain/model'
import { randomSelection, secureRandom, type RandomFilter, type ReviewState } from '../study/planner'
import type { Run } from './QuestionView'
export default function RandomDialog({section,questions,states,start,close,run,busy}: {
  section:Section;questions:Question[];states:Map<string,ReviewState>;start:(ids:string[])=>Promise<unknown>;close:()=>void;run:Run;busy:boolean;
}) {
  const dialog=useRef<HTMLDialogElement>(null)
  const [filter,setFilter]=useState<RandomFilter>('solved')
  const [size,setSize]=useState<number|'all'>(10)
  useEffect(()=> {dialog.current?.showModal()},[])
  const available=randomSelection(questions,states,filter,'all',()=>0).length
  return <dialog ref={dialog} className="draft-dialog compact" onClose={close} onCancel={close}><div className="modal-heading"><h2>Случайная тренировка</h2><button onClick={close} aria-label="Закрыть настройки">×</button></div><p>{section.section_title}</p><label>Какие вопросы<select value={filter} onChange={e=>setFilter(e.target.value as RandomFilter)}><option value="solved">Уже решённые</option><option value="new">Ещё не решённые</option><option value="all">Все вопросы раздела</option><option value="problematic">Проблемные / ошибки</option></select></label><label>Размер подборки<select value={size} onChange={e=>setSize(e.target.value==='all'?'all':Number(e.target.value))}><option value="10">10 вопросов</option><option value="20">20 вопросов</option><option value="all">Все доступные</option></select></label><p className="muted">Доступно: {available}. Вопросы не повторяются внутри подборки.</p><button className="primary" disabled={busy||!available} onClick={()=>run(()=>start(randomSelection(questions,states,filter,size,secureRandom)))}>Начать тренировку</button></dialog>
}
