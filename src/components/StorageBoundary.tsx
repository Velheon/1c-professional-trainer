import { Component, type ReactNode } from 'react'
export default class StorageBoundary extends Component<{children:ReactNode},{message:string}> {
  state={message:''}
  static getDerivedStateFromError(error:unknown) {return {message:error instanceof Error?error.message:'Неизвестная ошибка'}}
  render() {
    if(!this.state.message) return this.props.children
    return <main><section className="empty-state" role="alert"><h1>Не удалось открыть тренажёр</h1><p>Проверьте, разрешено ли браузеру хранить данные сайта, и попробуйте обновить страницу.</p><p>Не очищайте хранилище браузера: в нём может находиться ваша история.</p><details><summary>Подробности</summary><p>{this.state.message}</p></details><button className="primary" onClick={()=>location.reload()}>Обновить страницу</button></section></main>
  }
}
