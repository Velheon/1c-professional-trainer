import { useEffect, useState, type ReactNode } from 'react'
import { db } from '../storage/db'

export default function LocalStorageGate({children}:{children:ReactNode}) {
  const [ready,setReady]=useState(false)
  const [error,setError]=useState('')
  useEffect(()=>{
    let active=true
    const timer=setTimeout(()=>{
      if(active)setError('Браузер не открыл IndexedDB за 8 секунд. Закройте другие вкладки тренажёра и повторите запуск.')
    },8000)
    void db.open().then(()=>db.meta.get('profile')).then(()=>{
      if(active){clearTimeout(timer);setReady(true);setError('')}
    }).catch((cause:unknown)=>{
      if(active){clearTimeout(timer);setError(cause instanceof Error?cause.message:'IndexedDB недоступна')}
    })
    return ()=>{active=false;clearTimeout(timer)}
  },[])
  if(error)return <main className="auth-screen" role="alert">
    <h2>Не удалось открыть локальную базу</h2>
    <p>{error}</p>
    <p>Проверьте разрешение на хранение данных сайта. История остаётся в хранилище браузера.</p>
    <button onClick={()=>location.reload()}>Повторить запуск</button>
  </main>
  return ready?children:<p className="loading" role="status">Открываем IndexedDB…</p>
}
