import { useEffect, useRef, useState } from 'react'
import type { Attempt, Question } from '../domain/model'
export function buildDraft(q:Question,attempt?:Attempt,selected?:string) {
  const lines=[`Помоги разобраться с вопросом 1С:Профессионал.`,`Раздел ${q.section_order}: ${q.section_title}`,`Вопрос ${q.question_order}; UUID: ${q.question_id}`,q.text,'',...q.answers.map(a=>`${a.answer_order}. ${a.text}`)]
  if(q.image_attached) lines.push('К вопросу есть иллюстрация — приложу её вручную.')
  if(selected) lines.push(`Мой выбор: ${q.answers.find(a=>a.answer_id===selected)?.answer_order ?? 'не выбран'}`)
  if(attempt) lines.push(`Результат: ${attempt.is_correct?'верно':'ошибка'}`,`Верный вариант: ${q.answers.find(a=>a.is_correct)?.answer_order}`,`Пояснение источника: ${q.explanation}`,q.explanation_url)
  else lines.push('Объясни смысл вопроса без раскрытия ответа. Не указывай правильный вариант.')
  return lines.join('\n')
}
export function desktopChatAvailable() {
  return !/Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent) && !(navigator.maxTouchPoints>1 && /Macintosh/i.test(navigator.userAgent))
}
export default function ChatDraft({question,attempt,selected,close}: {question:Question;attempt?:Attempt;selected?:string;close:()=>void}) {
  const dialog=useRef<HTMLDialogElement>(null)
  const [text,setText]=useState(()=>buildDraft(question,attempt,selected))
  const [extra,setExtra]=useState('')
  const [status,setStatus]=useState('')
  useEffect(()=> {dialog.current?.showModal()},[])
  async function copy(open:boolean) {
    try {await navigator.clipboard.writeText(text+(extra?'\n\nМой вопрос: '+extra:''));setStatus('Скопировано. Вставьте и отправьте сообщение самостоятельно.');if(open)window.open('https://chatgpt.com/','_blank','noopener,noreferrer')}
    catch {setStatus('Не удалось скопировать. Выделите текст и скопируйте вручную.')}
  }
  return <dialog ref={dialog} className="draft-dialog" onCancel={close} onClose={close}><div className="modal-heading"><h2>Черновик для ChatGPT</h2><button onClick={close} aria-label="Закрыть черновик">×</button></div><p className="muted small">Текст можно изменить целиком. Приложение ничего не отправляет.</p><label>Текст сообщения<textarea value={text} onChange={e=>setText(e.target.value)} rows={13}/></label><label>Что именно хочешь спросить?<textarea value={extra} onChange={e=>setExtra(e.target.value)} rows={3}/></label><div className="actions"><button className="primary" onClick={()=>void copy(false)}>Скопировать</button><button onClick={()=>void copy(true)}>Скопировать и открыть ChatGPT</button></div><p role="status">{status}</p></dialog>
}
