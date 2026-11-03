import { useEffect, useState } from 'react'
interface InstallPrompt extends Event {prompt:()=>Promise<void>;userChoice:Promise<{outcome:'accepted'|'dismissed'}>}
export default function PwaPanel() {
  const [registration,setRegistration]=useState<ServiceWorkerRegistration|null>(null)
  const [ready,setReady]=useState(false),[update,setUpdate]=useState(false)
  const [install,setInstall]=useState<InstallPrompt|null>(null)
  const [persisted,setPersisted]=useState<boolean|null>(null)
  const [message,setMessage]=useState('')
  const [online,setOnline]=useState(navigator.onLine)
  useEffect(()=> {
    const refresh=()=>setOnline(navigator.onLine)
    const installPrompt=(event:Event)=> {event.preventDefault();setInstall(event as InstallPrompt)}
    const installed=()=>setInstall(null)
    window.addEventListener('online',refresh);window.addEventListener('offline',refresh)
    window.addEventListener('beforeinstallprompt',installPrompt);window.addEventListener('appinstalled',installed)
    void navigator.storage?.persisted?.().then(setPersisted)
    return ()=>{window.removeEventListener('online',refresh);window.removeEventListener('offline',refresh);window.removeEventListener('beforeinstallprompt',installPrompt);window.removeEventListener('appinstalled',installed)}
  },[])
  useEffect(()=> {
    if(!import.meta.env.PROD||!('serviceWorker' in navigator))return
    let disposed=false
    let cleanup=()=>{}
    const check=(r:ServiceWorkerRegistration)=> {if(!disposed){setReady(!!r.active);setUpdate(!!r.waiting)}}
    const added=(r:ServiceWorkerRegistration)=> {
      const worker=r.installing
      if(worker)worker.addEventListener('statechange',()=>check(r))
    }
    void navigator.serviceWorker.register(import.meta.env.BASE_URL+'sw.js',{scope:import.meta.env.BASE_URL,updateViaCache:'none'}).then(r=> {
      if(disposed)return
      setRegistration(r);check(r);const found=()=>added(r);r.addEventListener('updatefound',found);cleanup=()=>r.removeEventListener('updatefound',found);added(r)
      void navigator.serviceWorker.ready.then(()=>{if(!disposed)setReady(true)})
    }).catch(()=>{if(!disposed)setMessage('Не удалось подготовить запуск офлайн. Повторите открытие приложения с сетью.')})
    return ()=>{disposed=true;cleanup()}
  },[])
  function applyUpdate() {
    if(!registration?.waiting)return
    navigator.serviceWorker.addEventListener('controllerchange',()=>location.reload(),{once:true})
    registration.waiting.postMessage('ACTIVATE_UPDATE')
  }
  return <details className="pwa-panel"><summary>Установка и работа без сети{!online?' · офлайн':''}</summary>
    <p>{ready?'Оболочка приложения сохранена для запуска без сети.':import.meta.env.DEV?'Офлайн-запуск доступен в собранной версии PWA.':'Подготавливаем запуск без сети…'} Вопросы, иллюстрации и история хранятся в базе этого браузера после загрузки банка.</p>
    <div className="actions">{install&&<button onClick={()=>void install.prompt().then(()=>install.userChoice).then(result=>{if(result.outcome==='accepted')setInstall(null)}).catch(()=>setMessage('Воспользуйтесь пунктом «Установить приложение» в меню браузера.'))}>Установить приложение</button>}
      {persisted===false&&<button onClick={()=>void navigator.storage.persist().then(value=>{setPersisted(value);setMessage(value?'Браузер предоставил постоянное хранение.':'Браузер пока не предоставил постоянное хранение. Продолжайте делать копии JSON.')} ).catch(()=>setMessage('Не удалось запросить постоянное хранение.'))}>Сохранять данные на устройстве</button>}
      {update&&<button className="primary" onClick={applyUpdate}>Обновить приложение</button>}</div>
    {!install&&<p className="muted small">Установка: меню Chrome/Edge → «Установить приложение» или «Добавить на главный экран». На телефоне нужен HTTPS-адрес размещённой версии.</p>}
    {persisted&&<p className="muted small">Постоянное хранение включено. Очистка данных браузера всё равно удаляет локальную базу; сохраняйте JSON-копии.</p>}
    {update&&<p className="muted small">Новая версия готова. Обновление перезагрузит страницу; сохранённые ответы и позиция останутся.</p>}
    {message&&<p role="status">{message}</p>}
  </details>
}
