import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import type { Session as AuthSession } from '@supabase/supabase-js'
import { db } from '../storage/db'
import { bindAccount, resolveConflict, synchronize } from '../sync/engine'
import type { Binding } from '../sync/model'
import { projectUrl, supabase, localHost, configurationError, clearLocalAuth } from './client'
import { ensureCloudBank } from './bank'
import { SupabaseTransport } from './transport'
import ConflictCard from './ConflictCard'
import { CloudContext } from './context'
import { resumeSession } from '../study/service'
function describeError(error:unknown) {
  const e=error as {message?:string;code?:string}
  if(e?.code==='PGRST205'||e?.code==='PGRST202'||e?.message?.includes('schema cache'))return 'Настройка облака ещё не завершена. После настройки повторите проверку доступа.'
  if(e?.message?.includes('Invalid login credentials'))return 'Не удалось войти. Проверьте email и пароль аккаунта тренажёра.'
  if(e?.message?.includes('Failed to fetch')||e?.message?.includes('fetch failed'))return 'Нет соединения с Supabase. Локальные ответы сохранены; повторите позже.'
  return e?.message??'Не удалось синхронизировать. Локальные ответы сохранены.'
}
export default function CloudProvider({children}:{children:ReactNode}) {
  const binding=useLiveQuery(async()=>((await db.meta.get('cloudBinding'))?.value as Binding|undefined)??null,[])
  const conflicts=useLiveQuery(()=>db.conflicts.toArray(),[],[])
  const pending=useLiveQuery(()=>db.outbox.count(),[],0)
  const remoteActive=useLiveQuery(async()=> {
    const id=(await db.meta.get('remoteActive'))?.value
    return typeof id==='string'?db.sessions.get(id):undefined
  },[])
  const [auth,setAuth]=useState<AuthSession|null>(null)
  const [initialized,setInitialized]=useState(!supabase)
  const [membership,setMembership]=useState<string|null>(null)
  const [open,setOpen]=useState(false)
  const [email,setEmail]=useState(''),[password,setPassword]=useState('')
  const [accessCheck,setAccessCheck]=useState(0)
  const [consent,setConsent]=useState(false),[offline,setOffline]=useState(false)
  const [status,setStatus]=useState('Хранится на этом устройстве'),[error,setError]=useState(configurationError)
  const [busy,setBusy]=useState(false)
  const syncLock=useRef(false)
  const freshLogin=useRef<string|null>(null)
  const dialog=useRef<HTMLDialogElement>(null)
  useEffect(()=> {
    if(!supabase)return
    let active=true
    const {data:{subscription}}=supabase.auth.onAuthStateChange((_event,session)=> {if(active){setAuth(session);setInitialized(true);setMembership(null)}})
    void supabase.auth.getSession().then(({data,error})=>{if(active){setAuth(data.session);setInitialized(true);if(error)setError(describeError(error))}}).catch(e=>{if(active){setInitialized(true);setError(describeError(e))}})
    return ()=> {active=false;subscription.unsubscribe()}
  },[])
  const uid=auth?.user.id??null
  const matched=!!uid&&binding?.user_id===uid&&binding.project_url===projectUrl&&!binding.signed_out
  const doSync=useCallback(async()=> {
    if(!supabase||!uid||!matched||membership!==uid||syncLock.current)return
    if(!navigator.onLine){setStatus('Ожидает синхронизации · офлайн');return}
    syncLock.current=true;setStatus('Синхронизация…');setError('')
    try {
      await ensureCloudBank(db,supabase,uid,setStatus)
      await synchronize(db,uid,new SupabaseTransport(supabase,uid))
      const remains=await db.outbox.count(),collisions=await db.conflicts.count()
      setStatus(collisions?'Нужно выбрать версию данных':remains?'Ожидает синхронизации':'Синхронизировано')
    } catch(e){setStatus('Ошибка синхронизации');setError(describeError(e))}
    finally{syncLock.current=false}
  },[uid,matched,membership])
  useEffect(()=> {
    if(!uid||!supabase)return
    let cancelled=false
    void supabase.from('app_members').select('user_id').eq('user_id',uid).maybeSingle().then(({data,error})=> {
      if(cancelled)return
      if(error){setError(describeError(error));setMembership(null)}
      else if(!data){setError('Этот аккаунт не включён в личный список доступа к банку.');setMembership(null)}
      else{
        setMembership(uid);setError('')
        if(binding?.user_id===uid&&binding.project_url===projectUrl&&binding.signed_out&&freshLogin.current===uid) {
          void db.meta.put({key:'cloudBinding',value:{...binding,signed_out:false}}).catch(e=>setError(describeError(e)))
        }
        if(freshLogin.current===uid)freshLogin.current=null
      }
    })
    return ()=> {cancelled=true}
  },[uid,accessCheck,binding])
  useEffect(()=> {
    if(!matched||membership!==uid)return
    const timeout=setTimeout(()=>void doSync(),750)
    const timer=setInterval(()=>void doSync(),15_000)
    const online=()=>void doSync()
    window.addEventListener('online',online)
    return ()=> {clearTimeout(timeout);clearInterval(timer);window.removeEventListener('online',online)}
  },[doSync,matched,membership,uid,pending])
  useEffect(()=> {if(open)dialog.current?.showModal()},[open])
  useEffect(()=> {if(matched)setOpen(false)},[matched])
  useEffect(()=> {
    // Offline startup cannot verify membership. Recheck it when connectivity returns
    // so the queue resumes without another login or page refresh.
    const online=()=>setAccessCheck(n=>n+1)
    window.addEventListener('online',online)
    return ()=>window.removeEventListener('online',online)
  },[])
  const retrySync=()=> {if(membership!==uid)setAccessCheck(n=>n+1);else void doSync()}
  async function signIn(e:React.FormEvent) {
    e.preventDefault();if(!supabase)return
    setBusy(true);setError('')
    try {const {data,error}=await supabase.auth.signInWithPassword({email:email.trim(),password});if(error)throw error;freshLogin.current=data.user?.id??null;setAccessCheck(n=>n+1);setOffline(false)}
    catch(e){setError(describeError(e))}finally{setPassword('');setBusy(false)}
  }
  async function attach() {
    if(!uid||membership!==uid)return
    setBusy(true);setError('')
    try {await bindAccount(db,uid,projectUrl,consent);setOpen(false);setOffline(false)}
    catch(e){setError(describeError(e))}finally{setBusy(false)}
  }
  async function signOut() {
    if(syncLock.current){setError('Дождитесь завершения текущей отправки перед выходом.');return}
    // Revoke offline entry first; keep bank/history for the same owner without exposing it after logout.
    setBusy(true);freshLogin.current=null
    try {
      if(binding)await db.meta.put({key:'cloudBinding',value:{...binding,signed_out:true}})
      try {await supabase?.auth.signOut({scope:'local'})}
      finally {await clearLocalAuth();setAuth(null);setOffline(false);setOpen(false);setStatus('Вход не выполнен')}
    }catch(e){setError(describeError(e))}finally{setBusy(false)}
  }
  const gate=!!binding && (!matched || membership!==uid && !offline) || !localHost&&!matched
  const offlineAllowed=!!binding&&!binding.signed_out&&binding.project_url===projectUrl&&(!uid||uid===binding.user_id)
  const canShow=initialized&&binding!==undefined&&(!gate||(offline&&offlineAllowed))
  const authContent=<>
    <h2>Личный аккаунт</h2>
    <p className="muted small">Вопросы и история синхронизируются только с вашим проектом Supabase. Пароль не сохраняется в приложении.</p>
    {!supabase?<p>Облачные параметры не настроены или включён локальный режим.</p>:!uid?<form onSubmit={e=>void signIn(e)}><label>Email аккаунта тренажёра<input type="email" autoComplete="username" autoFocus value={email} onChange={e=>setEmail(e.target.value)} required/></label><label>Пароль<input type="password" autoComplete="current-password" value={password} onChange={e=>setPassword(e.target.value)} required/></label><button className="primary" disabled={busy}>Войти</button></form>:<>
      <p>Вход: {auth?.user.email}</p>
      {membership!==uid&&<button onClick={()=>setAccessCheck(n=>n+1)}>Проверить доступ</button>}
      {binding&&(binding.user_id!==uid||binding.project_url!==projectUrl)?<p role="alert">История этого браузера принадлежит другому аккаунту или проекту. Вернитесь к прежним параметрам и аккаунту для продолжения.</p>:binding&&!matched?<p>Проверяем доступ к вашему сохранённому профилю…</p>:!matched?<>
        <label className="check"><input type="checkbox" checked={consent} onChange={e=>setConsent(e.target.checked)}/>Привязать этот браузер к аккаунту и объединить местную историю с облаком, сохранив все попытки.</label>
        <button className="primary" disabled={busy||!consent||membership!==uid} onClick={()=>void attach()}>Подключить облако</button>
      </>:<p>{status}</p>}
      <button disabled={busy} onClick={()=>void signOut()}>Выйти из аккаунта</button>
    </>}
    {offlineAllowed && <button disabled={busy} onClick={()=>{setOffline(true);setOpen(false);setStatus('Локальная работа · отправка позже')}}>Продолжить офлайн на этом устройстве</button>}
    {error&&<p role="alert" className="cloud-error">{error}</p>}
  </>
  return <CloudContext.Provider value={{available:!!supabase,user:matched?auth?.user.email??uid:null,status:matched?status:'Хранится на этом устройстве',error,pending,open:()=>setOpen(true),sync:retrySync}}>
    {configurationError&&<aside className="cloud-notices" role="alert">{configurationError}</aside>}
    {!initialized||binding===undefined?<p className="loading" role="status">Открываем локальное хранилище…</p>:canShow?<>
      {matched && (error||conflicts.length>0||remoteActive) && <aside className="cloud-notices" aria-label="Облачная синхронизация">
        {error&&<p role="alert">{error} <button onClick={retrySync}>Повторить синхронизацию</button></p>}
        {remoteActive&&<p>На другом устройстве есть активная тренировка. <button onClick={()=>void resumeSession(remoteActive).then(()=>doSync()).catch(e=>setError(describeError(e)))}>Продолжить здесь</button></p>}
        {conflicts.map(c=><ConflictCard key={c.key} conflict={c} resolve={async choice=>{try{await resolveConflict(db,c,choice);await doSync()}catch(e){setError(describeError(e))}}}/>)}
      </aside>}
      {children}
    </>:<main className="auth-screen">{authContent}</main>}
    {open&&canShow&&<dialog ref={dialog} className="draft-dialog compact" onCancel={()=>{setPassword('');setOpen(false)}} onClose={()=>{setPassword('');setOpen(false)}}><div className="modal-heading"><span>Синхронизация</span><button aria-label="Закрыть вход" onClick={()=>{setPassword('');setOpen(false)}}>×</button></div>{authContent}</dialog>}
  </CloudContext.Provider>
}
