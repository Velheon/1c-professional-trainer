import { useRef, useState } from 'react'
import { exportHistory, MAX_BACKUP_BYTES, parseBackup, previewHistory, restoreHistory, type HistoryBackup, type RestorePolicy } from '../backup/history'
import type { Run } from './QuestionView'
export default function BackupPanel({run,busy}:{run:Run;busy:boolean}) {
  const [backup,setBackup]=useState<HistoryBackup|null>(null)
  const [preview,setPreview]=useState<Awaited<ReturnType<typeof previewHistory>>|null>(null)
  const [policy,setPolicy]=useState<RestorePolicy>('keep')
  const [message,setMessage]=useState('')
  const download=useRef<HTMLAnchorElement>(null)
  async function save() {
    const history=await exportHistory()
    const url=URL.createObjectURL(new Blob([JSON.stringify(history,null,2)],{type:'application/json'}))
    const a=download.current!;a.href=url;a.download=`1c-history-${new Date().toISOString().replace(/[:.]/g,'-')}.json`;a.click()
    setTimeout(()=>URL.revokeObjectURL(url),1000)
    setMessage('Копия подготовлена. Сохраните скачанный JSON в надёжном месте.')
  }
  return <details className="backup-panel"><summary>Резервная копия истории</summary>
    <p className="muted small">Копия содержит попытки, тренировки, отметки и тему. Банк вопросов, картинки, пароль и ключи входа в неё не входят.</p>
    <div className="actions"><button disabled={busy} onClick={()=>run(save)}>Скачать историю JSON</button><a ref={download} hidden aria-hidden="true"/>
      <label className="file-button">Восстановить из JSON<input aria-label="Загрузить резервную копию" type="file" accept=".json,application/json" disabled={busy} onChange={e=> {
        const file=e.target.files?.[0];e.target.value='';setBackup(null);setPreview(null);setMessage('')
        if(file)run(async()=> {if(file.size>MAX_BACKUP_BYTES)throw new Error('Размер копии превышает 50 МБ');const parsed=parseBackup(await file.text());const report=await previewHistory(parsed);setBackup(parsed);setPreview(report);setPolicy('keep')})
      }}/></label></div>
    {backup&&preview&&<section aria-label="Предварительный просмотр копии">
      <h3>Копия от {new Date(backup.created_at).toLocaleString('ru-RU')}</h3>
      <p>Новых попыток: {preview.newAttempts}. Уже есть: {preview.existingAttempts}. Новых отметок уверенности: {preview.newAnnotations}. Новых тренировок: {preview.newSessions}.</p>
      <p>Отличаются сохранённые тренировки: {preview.sessionConflicts}; отметки вопросов: {preview.flagConflicts}.</p>
      <label>Существующие тренировки, отметки и тема<select value={policy} onChange={e=>setPolicy(e.target.value as RestorePolicy)}><option value="keep">Сохранить текущие</option><option value="restore">Восстановить из копии</option></select></label>
      <p className="muted small">Попытки объединятся по UUID при любом выборе. Разделы из копии можно продолжить на главной. Завершённые экзамены не открываются заново. Текущая тренировка не переключится.</p>
      <div className="actions"><button className="primary" disabled={busy} onClick={()=>run(async()=> {const result=await restoreHistory(backup,policy);setBackup(null);setPreview(null);setMessage(`Восстановление завершено. Добавлено попыток: ${result.newAttempts}. Существующая история сохранена.`)})}>Объединить историю</button><button disabled={busy} onClick={()=>{setBackup(null);setPreview(null)}}>Отмена импорта</button></div>
    </section>}
    {message&&<p role="status">{message}</p>}
  </details>
}
