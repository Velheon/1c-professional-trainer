import { useEffect, useRef, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { db, importBank } from './storage/db'
import { readArchive } from './import/archive'
import { activeSession, currentId, move, resumeSession, startSession, updateSession, visibleAttempt } from './study/service'
import { compareEvents, effectiveUnsure, type Section } from './domain/model'
import CloudBar from './cloud/CloudBar'
import { useCloud } from './cloud/context'
import ThemeSwitcher from './components/ThemeSwitcher'
import QuestionView from './components/QuestionView'
import ChatDraft, { desktopChatAvailable } from './components/ChatDraft'
import RandomDialog from './components/RandomDialog'
import { deriveReview, dueQuestions } from './study/planner'
import { advance } from './study/advance'
import BackupPanel from './components/BackupPanel'
import PwaPanel from './components/PwaPanel'
import ExamView from './components/ExamView'
import { startExam } from './study/exam'
export default function App() {
  const cloud=useCloud()
  const data=useLiveQuery(async()=> ({
    sections:await db.sections.orderBy('section_order').toArray(),questions:await db.questions.toArray(),
    attempts:await db.attempts.toArray(),annotations:await db.annotations.toArray(),flags:await db.flags.toArray(),
    session:await activeSession(),sessions:await db.sessions.orderBy('updated_at').reverse().toArray(),report:(await db.meta.get('import'))?.value,
  }),[])
  const [home,setHome]=useState(false)
  const [examId,setExamId]=useState<string|null>(null)
  const [busy,setBusy]=useState(false)
  const [error,setError]=useState('')
  const [notice,setNotice]=useState('')
  const lock=useRef(false)
  const keyboardInput=useRef(false)
  useEffect(()=> {
    const key=()=> {keyboardInput.current=true}
    const pointer=()=> {keyboardInput.current=false}
    document.addEventListener('keydown',key,true)
    document.addEventListener('pointerdown',pointer,true)
    return ()=> {document.removeEventListener('keydown',key,true);document.removeEventListener('pointerdown',pointer,true)}
  },[])
  const [query,setQuery]=useState('')
  const [filter,setFilter]=useState('all')
  const [scope,setScope]=useState('all')
  const [randomSection,setRandomSection]=useState<Section|null>(null)
  const [chat,setChat]=useState(false)
  const [clock,setClock]=useState(()=>new Date())
  useEffect(()=> {const timer=setInterval(()=>setClock(new Date()),30_000);return ()=>clearInterval(timer)},[])
  function run(work:()=>Promise<unknown>) {
    if(lock.current) return
    lock.current=true;setBusy(true);setError('')
    void work().catch(e=>setError(e instanceof Error?e.message:'Не удалось сохранить действие. Повторите попытку.')).finally(()=> {lock.current=false;setBusy(false)})
  }
  function enterStudy() {setHome(false);setExamId(null);setNotice('')}
  async function importFile(file:File) {
    const result=await readArchive(new Uint8Array(await file.arrayBuffer()))
    const state=await importBank(result.bank,result.images,result.report)
    setNotice(`${state==='unchanged'?'Архив уже загружен. История сохранена.':'Импорт завершён.'} ${result.report.sections} разделов · ${result.report.questions} вопросов · ${result.report.answers} вариантов · ${result.report.images} иллюстраций. ${result.report.warnings.join(' ')}`)
  }
  if(!data) return <div className="loading" role="status">Открываем вашу практику…</div>
  const examSession=!home?(examId?data.sessions.find(s=>s.session_id===examId):data.session?.mode==='exam'?data.session:undefined):undefined
  const session=data.session
  const question=session ? data.questions.find(q=>q.question_id===currentId(session)) : undefined
  const answered=new Set(data.attempts.filter(a=>a.mode!=='exam').map(a=>a.question_id))
  const studying=!examSession && !home && session && session.status!=='completed' && question
  const attempt=question ? visibleAttempt(session!,question.question_id,data.attempts):undefined
  const states=deriveReview(data.attempts,data.annotations)
  const due=dueQuestions(states,new Date(Math.max(clock.getTime(),Date.now())))
  const flags=new Map(data.flags.map(f=>[f.question_id,f]))
  const latest=new Map([...data.attempts].filter(a=>a.mode!=='exam').sort(compareEvents).map(a=>[a.question_id,a]))
  const modes={sequential:'Изучение раздела',random:'Случайная тренировка',review:'Повторение',exam:'Пробный экзамен'}
  async function next() {
    if(!session) return
    const updated=await advance(session)
    if(updated.status==='completed') {setHome(true);setNotice('Тренировка завершена. Все ответы сохранены.')}
  }
  async function openQuestion(id:string) {
    const q=data!.questions.find(q=>q.question_id===id)!
    const qs=data!.questions.filter(x=>x.section_id===q.section_id).sort((a,b)=>a.question_order-b.question_order)
    const existing=data!.sessions.find(s=>s.mode==='sequential'&&s.section_id===q.section_id&&s.status!=='completed')
    const opened=existing ? await resumeSession(existing):await startSession('sequential',q.section_id,qs.map(x=>x.question_id))
    await move(opened,opened.question_ids.indexOf(id));enterStudy()
  }
  const showResults=query.trim()!==''||filter!=='all'
  const results=data.questions.filter(q=> {
    const state=states.get(q.question_id), flag=flags.get(q.question_id)
    const value=query.trim().toLocaleLowerCase('ru-RU')
    return (scope==='all'||q.section_id===scope) && (!value||q.text.toLocaleLowerCase('ru-RU').includes(value)||String(q.question_order)===value||`${q.section_order}.${q.question_order}`===value) &&
      (filter==='all'||filter==='new'&&!state||filter==='errors'&&state?.problematic||filter==='unsure'&&state&&!state.confidence||filter==='bookmarked'&&flag?.bookmarked||filter==='skipped'&&flag?.skipped)
  }).sort((a,b)=>a.section_order-b.section_order||a.question_order-b.question_order)
  return <><header className="site-header"><div className="header-inner"><button className="brand" onClick={()=>setHome(true)} aria-label="На главную"><span className="brand-icon">1С</span><span>Практика<small>Профессионал · Платформа 8.3</small></span></button><div className="header-controls"><ThemeSwitcher/><CloudBar/></div></div></header>
    <main>
      {error && <div role="alert" className="banner danger">{error}<button onClick={()=>setError('')} aria-label="Закрыть ошибку">×</button></div>}
      {notice && <div role="status" className="banner">{notice}<button onClick={()=>setNotice('')} aria-label="Закрыть уведомление">×</button></div>}
      {busy && <div className="busy" role="status">Сохраняем…</div>}
      {examSession ? <ExamView key={examSession.session_id} session={examSession} questions={data.questions} run={run} busy={busy} onHome={()=>{setHome(true);setExamId(null)}}/> : studying ? <><nav className="study-bar"><button onClick={()=>setHome(true)}>← Все разделы</button><span><span className="mode-badge">{modes[session.mode]}</span> {session.cursor+1} / {session.question_ids.length}</span><button disabled={busy} onClick={()=>run(async()=> {await updateSession(session,{status:'completed'});setHome(true)})}>Завершить тренировку</button></nav>
        <div className="study-layout"><div><QuestionView key={session.session_id+':'+question.question_id+':'+session.retry_ids.includes(question.question_id)} question={question} session={session} attempt={attempt} annotations={data.annotations} flag={data.flags.find(f=>f.question_id===question.question_id)} busy={busy} run={run} onNext={next} keyboardInput={keyboardInput.current} onChat={desktopChatAvailable()?()=>setChat(true):undefined}/>
          <div className="bottom-nav"><button disabled={session.cursor===0||busy} onClick={()=>run(()=>move(session,session.cursor-1))}>← Назад</button><button disabled={session.cursor===session.question_ids.length-1||busy} onClick={()=>run(()=>move(session,session.cursor+1))}>Далее →</button></div></div>
          <aside className="navigator"><h3>{session.mode==='sequential'?'Вопросы раздела':'Вопросы подборки'}</h3><p className="muted small">Можно вернуться к любому вопросу.</p><div className="question-grid">{session.question_ids.map((id,i)=> {
            const a=latest.get(id); const unsure=a&&effectiveUnsure(a,data.annotations)
            return <button key={id} aria-label={`Вопрос ${i+1}${a?unsure?', не уверен':a.is_correct?', верно':', ошибка':flags.get(id)?.skipped?', пропущен':', не отвечал'}`} aria-current={i===session.cursor?'step':undefined} className={`${i===session.cursor?'current ':''}${a?unsure?'unsure':a.is_correct?'done':'wrong':flags.get(id)?.skipped?'skipped':''}`} disabled={busy} onClick={()=>run(()=>move(session,i))}>{i+1}{!a && flags.get(id)?.skipped && <span className="tiny">–</span>}{flags.get(id)?.bookmarked && <span className="tiny bookmark-dot">★</span>}{a && <span className="tiny">{unsure?'?':a.is_correct?'✓':'×'}</span>}</button>
          })}</div></aside></div></> : <>
        <section className="welcome"><div><div className="eyebrow">Ваша подготовка к экзамену</div><h1>Разобраться.<br/><span>Запомнить. Сдать.</span></h1><p className="lead">Изучайте вопросы по порядку, разбирайте ответы<br className="desktop"/> и возвращайтесь к сложному в своём темпе.</p></div><div className="progress-card"><span className="eyebrow">Ваш прогресс</span><strong>{answered.size}<span> / {data.questions.length || '—'}</span></strong><progress value={answered.size} max={data.questions.length||1}/><p>вопросов изучено</p>{session && session.status!=='completed' && <button className="primary" onClick={()=>enterStudy()}>Продолжить обучение →</button>}</div></section>
        {!data.sections.length ? <section className="empty-state"><h2>Добавьте свой банк вопросов</h2><p>Выберите platform_83_export.zip. Он будет обработан в браузере и сохранён на этом устройстве.</p><label className="file-button primary">{busy?'Проверяем архив…':'Выбрать ZIP-архив'}<input aria-label="Импортировать архив" type="file" accept=".zip" disabled={busy} onChange={e=> {const file=e.target.files?.[0];if(file) run(()=>importFile(file));e.target.value=''}}/></label><p className="muted small">Архив и история не отправляются в интернет. Не очищайте данные браузера: пока они хранятся только локально.</p></section> : <>
          <div className="stats-row">
            <div className="stat-tile"><strong>{data.questions.length-answered.size}</strong><span>Ещё не изучено</span></div>
            <div className="stat-tile"><strong>{due.length}</strong><span>К повторению сейчас</span><br/><button disabled={busy} onClick={()=>run(async()=> {if(!due.length){setNotice('Пока нет вопросов к повторению. Продолжайте изучение разделов.');return}await startSession('review',null,due.map(s=>s.question_id));enterStudy()})}>Начать повторение →</button></div>
            <div className="stat-tile"><strong>{[...states.values()].filter(s=>s.problematic).length}</strong><span>Проблемные</span><br/><span>Неуверенных: {[...states.values()].filter(s=>!s.confidence).length}</span></div>
            <div className="stat-tile"><strong>{[...states.values()].filter(s=>s.mastered).length}</strong><span>Освоено</span></div>
          </div>
          <section className="exam-start"><div><h2>Пробный экзамен</h2><p className="muted small">14 вопросов · 30 минут · порог 12. Подборка по разным разделам; это учебная модель, а не официальный механизм подбора. Таймер идёт после закрытия страницы.</p></div><button className="primary" disabled={busy} onClick={()=>run(async()=>{const s=await startExam();setExamId(s.session_id);setHome(false);setNotice('')})}>Начать пробный экзамен</button></section>
          <details className="session-list"><summary>Результаты экзаменов ({data.sessions.filter(s=>s.mode==='exam'&&s.status==='completed').length})</summary>{data.sessions.filter(s=>s.mode==='exam'&&s.status==='completed').map(s=><button key={s.session_id} onClick={()=>{setExamId(s.session_id);setHome(false)}}>Пробный экзамен · {new Date(s.exam?.finished_at??s.updated_at).toLocaleString('ru-RU')}</button>)}</details>
          <div className="tools"><input type="search" aria-label="Поиск вопросов" placeholder="Найти вопрос по тексту или номеру…" value={query} onChange={e=>setQuery(e.target.value)}/><select aria-label="Область поиска" value={scope} onChange={e=>setScope(e.target.value)}><option value="all">Все разделы</option>{data.sections.map(s=><option value={s.section_id} key={s.section_id}>Раздел {s.section_order}</option>)}</select><select aria-label="Фильтр вопросов" value={filter} onChange={e=>setFilter(e.target.value)}><option value="all">Все вопросы</option><option value="new">Не отвечал</option><option value="errors">Проблемные / ошибки</option><option value="unsure">Неуверенные</option><option value="bookmarked">Отмеченные</option><option value="skipped">Пропущенные</option></select></div>
          {showResults && <section className="search-results" aria-label="Результаты поиска"><p className="muted small">Найдено: {results.length}</p>{results.slice(0,100).map(q=><button className="search-result" key={q.question_id} disabled={busy} onClick={()=>run(()=>openQuestion(q.question_id))}><span>{q.section_order}.{q.question_order}</span><div>{q.text}<small>{q.section_title}</small></div></button>)}{results.length>100&&<p className="muted small">Показаны первые 100. Уточните поиск.</p>}</section>}
          <details className="session-list"><summary>Сохранённые тренировки ({data.sessions.filter(s=>s.status!=='completed').length})</summary>{data.sessions.filter(s=>s.status!=='completed').map(s=><button key={s.session_id} disabled={busy} onClick={()=>run(async()=> {await resumeSession(s);enterStudy()})}>{modes[s.mode]} · {s.section_id?`Раздел ${data.sections.find(x=>x.section_id===s.section_id)?.section_order}`:'Все разделы'} · {s.cursor+1}/{s.question_ids.length}</button>)}</details>
          <div className="section-heading"><div><h2>Изучение по разделам</h2><p className="muted">Исходный порядок вопросов и вариантов сохранён.</p></div><label className="file-button">Повторный импорт<input type="file" aria-label="Повторный импорт" accept=".zip" disabled={busy} onChange={e=> {const file=e.target.files?.[0];if(file) run(()=>importFile(file));e.target.value=''}}/></label></div>
          <div className="sections">{data.sections.map(s=> {
            const qs=data.questions.filter(q=>q.section_id===s.section_id).sort((a,b)=>a.question_order-b.question_order)
            const count=qs.filter(q=>answered.has(q.question_id)).length
            return <article className="section-card" key={s.section_id}><div className="section-number">{String(s.section_order).padStart(2,'0')}</div><h3>{s.section_title}</h3><div className="section-progress"><span>{count} / {s.question_count} изучено</span><span>{Math.round(count/s.question_count*100)}%</span></div><progress value={count} max={s.question_count}/><div className="actions"><button className="primary" disabled={busy} onClick={()=>run(async()=> {
              const saved=data.sessions.find(x=>x.section_id===s.section_id && x.mode==='sequential' && x.status!=='completed')
              if(saved) {await resumeSession(saved);enterStudy()}
              else {const next=await startSession('sequential',s.section_id,qs.map(q=>q.question_id));const first=qs.findIndex(q=>!answered.has(q.question_id));if(first>0) await move(next,first);enterStudy()}
            })}>{count?'Продолжить':'Начать изучение'} →</button>{count>0 && <button className="subtle" aria-label={`Начать раздел ${s.section_order} сначала`} disabled={busy} onClick={()=>run(async()=> {await startSession('sequential',s.section_id,qs.map(q=>q.question_id));enterStudy()})}>Сначала</button>}<button className="subtle" disabled={busy} onClick={()=>setRandomSection(s)}>Случайная тренировка</button></div></article>
          })}</div>
        </>}
      </>}
      {!studying&&!examSession&&<div className="maintenance-panels"><BackupPanel run={run} busy={busy}/></div>}
      <div hidden={!!studying||!!examSession}><PwaPanel/></div>
      <footer className="site-footer"><span>Личный тренажёр · 1С:Профессионал</span><span>{cloud.user?'Локальное сохранение · '+cloud.status:'Ответы сохраняются на этом устройстве. Облако не подключено.'}</span></footer>
    </main>
    {randomSection && <RandomDialog section={randomSection} questions={data.questions.filter(q=>q.section_id===randomSection.section_id)} states={states} run={run} busy={busy} close={()=>setRandomSection(null)} start={async ids=> {await startSession('random',randomSection.section_id,ids);setRandomSection(null);enterStudy()}}/>}
    {chat && studying && <ChatDraft question={question} selected={session.choices[question.question_id]} attempt={session.retry_ids.includes(question.question_id)?undefined:attempt} close={()=>setChat(false)}/>}
    </>
}
