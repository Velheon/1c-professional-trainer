import { useState } from 'react'
import type { Question, Flag } from '../domain/model'
import type { Statistics } from '../analytics/statistics'
import type { ReviewState } from '../study/planner'
import { setFlag } from '../study/service'
import type { Run } from './QuestionView'

type CollectionFilter='all'|'errors'|'new'|'due'
const filters:Record<CollectionFilter,string>={all:'Все',errors:'С ошибками',new:'Не изученные',due:'Требующие повторения'}
export default function QuestionCollection({title,questions,stats,states,flags,now,favorites,run,busy,open,train}:{
  title:string;questions:Question[];stats:Statistics;states:Map<string,ReviewState>;flags:Map<string,Flag>
  now:Date;favorites:boolean;run:Run;busy:boolean;open:(id:string)=>void;train:(items:Question[])=>void
}) {
  const [filter,setFilter]=useState<CollectionFilter>('all')
  const [search,setSearch]=useState('')
  const [limit,setLimit]=useState(60)
  const query=search.trim().toLocaleLowerCase('ru')
  const filtered=questions.filter(q=>{
    const history=stats.questions.get(q.question_id)
    const state=states.get(q.question_id)
    return (!query||q.text.toLocaleLowerCase('ru').includes(query)||`${q.section_order}.${q.question_order}`.includes(query))&&
      (filter==='all'||filter==='errors'&&!!(history?.first.wrong||history?.repeat.wrong)||
       filter==='new'&&!history||filter==='due'&&!!state&&Date.parse(state.due_at)<=now.getTime())
  })
  return <section className="collection-page">
    <h1>{title}</h1>
    <div className="tools">
      <select aria-label="Фильтр списка" value={filter} onChange={e=>{setFilter(e.target.value as CollectionFilter);setLimit(60)}}>
        {Object.entries(filters).map(([id,label])=><option key={id} value={id}>{label}</option>)}
      </select>
      <input type="search" aria-label="Поиск в списке" placeholder="Текст или номер вопроса" value={search} onChange={e=>{setSearch(e.target.value);setLimit(60)}}/>
      <button className="primary" disabled={busy||!filtered.length} onClick={()=>train(filtered)}>{favorites?'Тренировать избранное':'Тренировать тему'}</button>
    </div>
    <p className="muted">Вопросов в подборке {filtered.length} из {questions.length}</p>
    {!filtered.length&&<p>{favorites&&!questions.length?'Отметьте вопросы звёздочкой, чтобы добавить их сюда.':'По этому фильтру вопросов нет.'}</p>}
    <div className="collection-list">
      {filtered.slice(0,limit).map(q=>{
        const history=stats.questions.get(q.question_id)
        const state=states.get(q.question_id)
        const bookmarked=!!flags.get(q.question_id)?.bookmarked
        return <article key={q.question_id} className="collection-row">
          <button className="search-result" disabled={busy} onClick={()=>open(q.question_id)}>
            <span>{q.section_order}.{q.question_order}</span>
            <div><strong>{q.text}</strong><small>{q.section_title}</small>
              <small>{state?state.problematic?'Требует повторения':'Изучен':'Не изучен'}{history?.first.wrong||history?.repeat.wrong?' · Есть ошибки в истории':''}</small>
            </div>
          </button>
          <button className={`star ${bookmarked?'active':''}`} disabled={busy} aria-label={bookmarked?'Убрать закладку':'Добавить закладку'}
            aria-pressed={bookmarked} onClick={()=>run(()=>setFlag(q.question_id,'bookmarked',!bookmarked))}>{bookmarked?'★':'☆'}</button>
        </article>
      })}
    </div>
    {filtered.length>limit&&<button onClick={()=>setLimit(n=>n+60)}>Показать ещё</button>}
  </section>
}
