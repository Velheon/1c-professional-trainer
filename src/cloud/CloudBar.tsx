import { useCloud } from './context'
export default function CloudBar() {
  const cloud=useCloud()
  return <div className="cloud-bar"><span className="local-status" role="status"><span className="status-dot"/>{cloud.status}</span>{cloud.available&&<div className="cloud-actions"><button onClick={cloud.open}>{cloud.user?'Аккаунт':'Подключить облако'}</button>{cloud.user&&<button onClick={cloud.sync} aria-label="Повторить синхронизацию">↻{cloud.pending?` ${cloud.pending}`:''}</button>}</div>}</div>
}
