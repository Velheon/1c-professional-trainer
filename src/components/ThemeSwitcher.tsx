import { useLayoutEffect, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '../storage/db'
import { setTheme } from '../sync/preferences'
type Theme = 'dark'|'light'|'system'
export default function ThemeSwitcher() {
  const preference=useLiveQuery(()=>db.meta.get('theme'),[])
  const value=preference?.value
  const theme:Theme=value==='light'||value==='system'?value:'dark'
  const [error,setError]=useState('')
  useLayoutEffect(()=> {
    const media=matchMedia('(prefers-color-scheme: dark)')
    const apply=()=> {document.documentElement.dataset.theme=theme==='system'?(media.matches?'dark':'light'):theme}
    apply();media.addEventListener('change',apply)
    return ()=>media.removeEventListener('change',apply)
  },[theme])
  return <div className="theme-control"><select aria-label="Тема оформления" value={theme} onChange={e=> {
    setError('');void setTheme(e.target.value as Theme).catch(()=>setError('Не удалось сохранить тему'))
  }}><option value="dark">Тёмная</option><option value="light">Светлая</option><option value="system">Как в системе</option></select>{error&&<span role="alert">{error}</span>}</div>
}
