import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import type { Session as AuthSession, SupabaseClient } from '@supabase/supabase-js'
import { db } from '../storage/db'
import { bindAccount, resolveConflict, synchronize } from '../sync/engine'
import type { Binding } from '../sync/model'
import { projectUrl, supabase, localHost, configurationError, clearLocalAuth } from './client'
import { ensureCloudBank } from './bank'
import { SupabaseTransport } from './transport'
import ConflictCard from './ConflictCard'
import { CloudContext } from './context'
import { ACCESS_RECHECK_MS, allowsOffline, type AccessLease } from './access'
import { resumeSession } from '../study/service'
function describeError(error:unknown) {
  const e=error as {message?:string;code?:string;name?:string}
  if(e?.name==='TimeoutError'||e?.message?.includes('TimeoutError'))return 'Supabase не ответил вовремя. Изменения остаются на устройстве.'
  if(e?.code==='PGRST205'||e?.code==='PGRST202'||e?.message?.includes('schema cache'))return 'Настройка облака ещё не завершена. После настройки повторите проверку доступа.'
  if(e?.message?.includes('Invalid login credentials'))return 'Не удалось войти. Проверьте email и пароль аккаунта тренажёра.'
  if(e?.message?.includes('Failed to fetch')||e?.message?.includes('fetch failed'))return 'Нет соединения с Supabase. Локальные ответы сохранены; повторите позже.'
  return e?.message??'Не удалось синхронизировать. Локальные ответы сохранены.'
}
function checkMembership(client:SupabaseClient,uid:string) {
  const controller=new AbortController()
  let timer:ReturnType<typeof setTimeout>
  const deadline=new Promise<{data:null;error:Error;status:number}>(resolve=>{
    timer=setTimeout(()=>{
      controller.abort()
      resolve({data:null,error:new DOMException('Membership check timed out','TimeoutError'),status:0})
    },12_000)
  })
  const query=Promise.resolve(client.from('app_members').select('user_id')
    .eq('user_id',uid).abortSignal(controller.signal).maybeSingle())
  return Promise.race([query,deadline]).finally(()=>clearTimeout(timer))
}

export default function CloudProvider({children}:{children:ReactNode}) {
  const binding=useLiveQuery(async()=>((await db.meta.get('cloudBinding'))?.value as Binding|undefined)??null,[])
  const localAccess=useLiveQuery(async()=>({
    lease:(await db.meta.get('accessLease'))?.value as AccessLease|undefined,
    bankOwner:(await db.meta.get('cloudBankReady'))?.value,
  }),[])
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
  const [consent,setConsent]=useState(false)
  const [online,setOnline]=useState(navigator.onLine)
  const [denied,setDenied]=useState(false)
  const [unreachable,setUnreachable]=useState(!navigator.onLine)
  const [checking,setChecking]=useState(false)
  const lastAccessCheck=useRef(0)
  const [accessTime,setAccessTime]=useState(Date.now)
  const membershipRequest=useRef<{uid:string;result:PromiseLike<{data:unknown;error:unknown;status:number}>}|null>(null)
  const [status,setStatus]=useState('Хранится на этом устройстве'),[error,setError]=useState(configurationError)
  const [busy,setBusy]=useState(false)
  const syncLock=useRef(false)
  const freshLogin=useRef<string|null>(null)
  const dialog=useRef<HTMLDialogElement>(null)
  useEffect(()=> {
    if(!supabase)return
    let active=true, receivedAuthEvent=false
    const initTimeout=setTimeout(()=>{
      if(active){setInitialized(true);setUnreachable(true)}
    },8000)
    const revoke=()=>{
      setMembership(null)
      setDenied(true)
      void db.meta.delete('accessLease').catch(e=>setError(describeError(e)))
    }
    const {data:{subscription}}=supabase.auth.onAuthStateChange((event,session)=>{
      if(!active)return
      receivedAuthEvent=true
      clearTimeout(initTimeout)
      setAuth(session);setInitialized(true)
      if(event==='SIGNED_OUT')revoke()
    })
    void supabase.auth.getSession().then(({data,error})=>{
      if(!active)return
      clearTimeout(initTimeout)
      if(!receivedAuthEvent)setAuth(data.session)
      setInitialized(true)
      if(error){
        setError(describeError(error))
        if(error.status===401||error.status===403||['refresh_token_not_found','session_not_found','invalid_grant'].includes(error.code??''))revoke()
        else setUnreachable(true)
      } else if(!data.session&&!receivedAuthEvent&&navigator.onLine) {
        // A missing online session does not authorize opening cached private content.
        setUnreachable(false)
      }
    }).catch(e=>{if(active){clearTimeout(initTimeout);setInitialized(true);setUnreachable(true);setError(describeError(e))}})
    return ()=> {active=false;clearTimeout(initTimeout);subscription.unsubscribe()}
  },[])
  const uid=auth?.user.id??null
  const matched=!!uid&&binding?.user_id===uid&&binding.project_url===projectUrl&&!binding.signed_out
  const doSync=useCallback(async()=> {
    if(!supabase||!uid||!matched||membership!==uid||denied||syncLock.current)return
    if(!navigator.onLine){setStatus('Ожидает синхронизации · офлайн');return}
    syncLock.current=true;setStatus('Синхронизация…');setError('')
    try {
      await ensureCloudBank(db,supabase,uid,setStatus)
      await synchronize(db,uid,new SupabaseTransport(supabase,uid))
      const remains=await db.outbox.count(),collisions=await db.conflicts.count()
      setStatus(collisions?'Нужно выбрать версию данных':remains?'Ожидает синхронизации':'Синхронизировано')
    } catch(e){
      setStatus('Ошибка синхронизации');setError(describeError(e))
      const failure=e as {status?:number;code?:string;message?:string}
      if(failure.status===401||failure.status===403||failure.code==='42501'||failure.code==='PGRST301'||failure.message==='MEMBERSHIP_REQUIRED') {
        setMembership(null);setDenied(true)
        await db.meta.delete('accessLease')
      }
    }
    finally{syncLock.current=false}
  },[uid,matched,membership,denied])
  useEffect(()=> {
    if(!uid||!supabase||!online){setChecking(false);return}
    let cancelled=false
    lastAccessCheck.current=Date.now()
    setChecking(true)
    if(membershipRequest.current?.uid!==uid) {
      const result=checkMembership(supabase,uid)
      membershipRequest.current={uid,result}
      void result.finally(()=>{if(membershipRequest.current?.result===result)membershipRequest.current=null}).catch(()=>{})
    }
    void Promise.resolve(membershipRequest.current.result).then(async({data,error,status:responseStatus})=>{
      if(cancelled)return
      if(error||!data){
        setMembership(null)
        setError(error?describeError(error):'Аккаунт отсутствует в списке доступа к банку.')
        if(!error||[401,403].includes(responseStatus)||(error as {code?:string})?.code==='42501'){
          setDenied(true);setUnreachable(false)
          await db.meta.delete('accessLease')
        }else setUnreachable(true)
        return
      }
      await db.transaction('rw',db.meta,async()=>{
        if(cancelled)return
        const current=(await db.meta.get('cloudBinding'))?.value as Binding|undefined
        const explicitLogin=freshLogin.current===uid
        if(current?.signed_out&&!explicitLogin)return
        if(current&&(current.user_id!==uid||current.project_url!==projectUrl))return
        if(current?.signed_out)await db.meta.put({key:'cloudBinding',value:{...current,signed_out:false}})
        await db.meta.put({key:'accessLease',value:{user_id:uid,project_url:projectUrl,verified_at:Date.now()}})
      })
      if(cancelled)return
      if(freshLogin.current===uid)freshLogin.current=null
      setMembership(uid);setDenied(false);setUnreachable(false);setError('')
    }).catch(e=>{
      if(!cancelled){setMembership(null);setUnreachable(true);setError(describeError(e))}
    }).finally(()=>{if(!cancelled)setChecking(false)})
    return ()=>{cancelled=true}
  },[uid,accessCheck,online])
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
  useEffect(()=>{
    const refresh=()=>{
      setAccessTime(Date.now())
      if(document.visibilityState==='visible'&&Date.now()-lastAccessCheck.current>=ACCESS_RECHECK_MS)setAccessCheck(n=>n+1)
    }
    const connection=()=>{setOnline(navigator.onLine);if(!navigator.onLine)setUnreachable(true);setAccessTime(Date.now())}
    const timer=setInterval(refresh,30_000)
    document.addEventListener('visibilitychange',refresh)
    window.addEventListener('online',connection)
    window.addEventListener('offline',connection)
    return ()=>{
      clearInterval(timer)
      document.removeEventListener('visibilitychange',refresh)
      window.removeEventListener('online',connection)
      window.removeEventListener('offline',connection)
    }
  },[])
  const retrySync=()=> {if(membership!==uid||denied)setAccessCheck(n=>n+1);else void doSync()}
  async function signIn(e:React.FormEvent) {
    e.preventDefault();if(!supabase)return
    setBusy(true);setError('')
    try {const {data,error}=await supabase.auth.signInWithPassword({email:email.trim(),password});if(error)throw error;freshLogin.current=data.user?.id??null;setAccessCheck(n=>n+1)}
    catch(e){setError(describeError(e))}finally{setPassword('');setBusy(false)}
  }
  async function attach() {
    if(!uid||membership!==uid)return
    setBusy(true);setError('')
    try {await bindAccount(db,uid,projectUrl,consent);setOpen(false)}
    catch(e){setError(describeError(e))}finally{setBusy(false)}
  }
  async function signOut() {
    if(syncLock.current){setError('Дождитесь завершения текущей отправки перед выходом.');return}
    // Revoke offline entry first; keep bank/history for the same owner without exposing it after logout.
    setBusy(true);freshLogin.current=null
    try {
      await db.transaction('rw',db.meta,async()=>{
        if(binding)await db.meta.put({key:'cloudBinding',value:{...binding,signed_out:true}})
        await db.meta.delete('accessLease')
      })
      try {await supabase?.auth.signOut({scope:'local'})}
      finally {await clearLocalAuth();setAuth(null);setOpen(false);setStatus('Вход не выполнен')}
    }catch(e){setError(describeError(e))}finally{setBusy(false)}
  }
  const offlineAllowed=!denied&&allowsOffline(binding,localAccess?.lease,localAccess?.bankOwner,projectUrl,uid,Math.max(accessTime,Date.now()))
  const offline=offlineAllowed&&(!online||unreachable)
  const canShow=initialized&&binding!==undefined&&(!binding&&localHost||matched&&membership===uid&&online&&!unreachable&&!denied||offline)
  const displayStatus=offline?(pending?'Работа без сети · есть изменения':'Работа без сети'):matched?status:'Хранится на этом устройстве'
  const authContent=<>
    <h2>Личный аккаунт</h2>
    <p className="muted small">Вопросы и история синхронизируются только с вашим проектом Supabase. Пароль не сохраняется в приложении.</p>
    {!supabase?<p>Облачные параметры не настроены или включён локальный режим.</p>:!uid?<form onSubmit={e=>void signIn(e)}><label>Email аккаунта тренажёра<input type="email" autoComplete="username" autoFocus value={email} onChange={e=>setEmail(e.target.value)} required/></label><label>Пароль<input type="password" autoComplete="current-password" value={password} onChange={e=>setPassword(e.target.value)} required/></label><button className="primary" disabled={busy}>Войти</button></form>:<>
      <p>Вход: {auth?.user.email}</p>
      {checking&&<p role="status">Проверяем доступ к банку…</p>}
      {membership!==uid&&!checking&&<button onClick={()=>setAccessCheck(n=>n+1)}>Повторить проверку доступа</button>}
      {binding&&(binding.user_id!==uid||binding.project_url!==projectUrl)?<p role="alert">История этого браузера принадлежит другому аккаунту или проекту. Вернитесь к прежним параметрам и аккаунту для продолжения.</p>:binding&&!matched?<p>Проверяем доступ к вашему сохранённому профилю…</p>:!matched?<>
        <label className="check"><input type="checkbox" checked={consent} onChange={e=>setConsent(e.target.checked)}/>Привязать этот браузер к аккаунту и объединить местную историю с облаком, сохранив все попытки.</label>
        <button className="primary" disabled={busy||!consent||membership!==uid} onClick={()=>void attach()}>Подключить облако</button>
      </>:<p>{status}</p>}
    </>}
    {(uid||offline)&&<button disabled={busy} onClick={()=>void signOut()}>Выйти из аккаунта</button>}
    {binding&&!binding.signed_out&&!canShow&&(!online||unreachable)&&<p>Для офлайн-входа нужна загруженная база и недавняя проверка доступа. Подключитесь к сети и повторите вход.</p>}
    {error&&<p role="alert" className="cloud-error">{error}</p>}
  </>
  return <CloudContext.Provider value={{available:!!supabase,user:matched?auth?.user.email??uid:offline?binding?.user_id??null:null,status:displayStatus,error,pending,open:()=>setOpen(true),sync:retrySync}}>
    {configurationError&&<aside className="cloud-notices" role="alert">{configurationError}</aside>}
    {!initialized||binding===undefined?<p className="loading" role="status">Восстанавливаем вход…</p>:canShow?<>
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
