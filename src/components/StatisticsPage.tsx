import { useMemo, useState } from 'react'
import { accuracy, activityBuckets, dayKey, emptyMetrics, metricCounts, summarize, total, type Metric, type Period, type Statistics } from '../analytics/statistics'
import { mechanismById, mechanismIds, mechanisms, type Classification } from '../analytics/mechanisms'
import type { Question, Section } from '../domain/model'

export interface QuestionGroup {
  id:string
  title:string
  questionIds:Set<string>
}

export function analyticsGroups(questions:Question[],sections:Section[],tags:Map<string,Classification>) {
  const bySection=new Map<string,Set<string>>(),byMechanism=new Map<string,Set<string>>()
  for(const q of questions) {
    const sectionIds=bySection.get(q.section_id)??new Set<string>()
    sectionIds.add(q.question_id)
    bySection.set(q.section_id,sectionIds)
    const classification=tags.get(q.question_id)
    if(!classification)continue
    for(const id of mechanismIds(classification)) {
      const ids=byMechanism.get(id)??new Set<string>()
      ids.add(q.question_id)
      byMechanism.set(id,ids)
    }
  }
  return {
    sections:sections.map(s=>({id:s.section_id,title:`${s.section_order}. ${s.section_title}`,questionIds:bySection.get(s.section_id)??new Set<string>()})),
    mechanisms:mechanisms.map(m=>({id:m.id,title:m.title,questionIds:byMechanism.get(m.id)??new Set<string>()})),
  }
}

const formatRate=(n:number|null)=>n===null?'—':`${n}%`
const metricNames={first:'Первые ответы',all:'Все попытки',repeat:'Повторения'}
function ActivityChart({buckets,kind}:{buckets:ReturnType<typeof activityBuckets>;kind:'activity'|'accuracy'}) {
  const [selected,setSelected]=useState('')
  const active=buckets.find(b=>b.key===selected)??buckets.filter(b=>total(metricCounts(b.metrics,'all'))>0).at(-1)
  const max=Math.max(1,...buckets.map(b=>total(metricCounts(b.metrics,'all'))))
  const title=kind==='activity'?'Активность':'Точность ответов'
  return <section className="analysis-card">
    <h2>{title}</h2>
    {kind==='activity'&&<p className="chart-legend"><span className="legend-first">Новые вопросы</span><span className="legend-repeat">Повторные ответы</span></p>}
    {buckets.some(b=>total(metricCounts(b.metrics,'all'))>0)?<>
      <div className="chart-track" role="group" aria-label={title}>
        {buckets.map(b=>{
          const first=total(b.metrics.first),repeat=total(b.metrics.repeat),rate=accuracy(metricCounts(b.metrics,'all'))
          const firstHeight=first*94/max,repeatHeight=repeat*94/max
          const description=`${b.label}. Новых ${first}, повторных ${repeat}. ${rate===null?'Нет ответов':`Точность ${rate}%`}`
          return <button key={b.key} type="button" className="chart-column" aria-label={description} title={description}
            aria-pressed={b.key===active?.key} onFocus={()=>setSelected(b.key)} onPointerEnter={()=>setSelected(b.key)} onClick={()=>setSelected(b.key)}>
            <svg viewBox="0 0 26 100" aria-hidden="true">
              <path d="M0 98h26" className="chart-baseline"/>
              {kind==='activity'?<>
                <rect className="chart-first" x="4" y={98-firstHeight} width="18" height={firstHeight}/>
                <rect className="chart-repeat" x="4" y={98-firstHeight-repeatHeight} width="18" height={repeatHeight}/>
              </>:rate===null?null:<>
                <path className="chart-stem" d={`M13 98V${94-rate*.88}`}/>
                <circle className="chart-first" cx="13" cy={94-rate*.88} r="4"/>
              </>}
            </svg>
            <span>{b.label}</span>
          </button>
        })}
      </div>
      <div className="chart-detail" aria-live="polite">{active&&<>
        <strong>{active.label}</strong>
        <span>Новых {total(active.metrics.first)} · повторных {total(active.metrics.repeat)}</span>
        <span>Верных {metricCounts(active.metrics,'all').correct} · ошибок {metricCounts(active.metrics,'all').wrong}</span>
        <span>Точность {formatRate(accuracy(metricCounts(active.metrics,'all')))}</span>
      </>}</div>
    </>:<p className="muted">За этот период ответов ещё нет.</p>}
  </section>
}

export default function StatisticsPage({stats,groups,now,openGroup}:{
  stats:Statistics
  groups:ReturnType<typeof analyticsGroups>
  now:Date
  openGroup:(group:QuestionGroup)=>void
}) {
  const [period,setPeriod]=useState<Period>('week')
  const [view,setView]=useState<'sections'|'mechanisms'>('sections')
  const [metric,setMetric]=useState<Metric>('all')
  const [tag,setTag]=useState('')
  const today=stats.days.get(dayKey(now))??emptyMetrics()
  const counts=metricCounts(today,'all')
  const buckets=useMemo(()=>activityBuckets(stats,period,now),[stats,period,now])
  const rows=useMemo(()=>groups[view].filter(g=>view==='sections'||g.questionIds.size>=6)
    .map(group=>({group,...summarize(group.questionIds,stats)})),[groups,view,stats])
  const selected=groups.mechanisms.find(g=>g.id===tag)
  return <div className="analytics-page">
    <h1>Статистика</h1>
    <p className="muted">Учебные ответы по местному времени. Результаты пробных экзаменов доступны отдельно.</p>
    <section aria-label="Сегодня">
      <h2>Сегодня</h2>
      <div className="stats-row today-stats">
        {[[total(today.first),'Новых вопросов'],[total(today.repeat),'Повторных ответов'],[counts.correct,'Правильных'],[counts.wrong,'Неправильных'],[formatRate(accuracy(counts)),'Точность']].map(([value,label])=>
          <div className="stat-tile" key={label}><strong>{value}</strong><span>{label}</span></div>)}
      </div>
    </section>
    <div className="actions" role="group" aria-label="Период графиков">
      {([['week','Неделя'],['month','Месяц'],['all','Всё время']] as const).map(([id,label])=>
        <button key={id} aria-pressed={period===id} onClick={()=>setPeriod(id)}>{label}</button>)}
    </div>
    <div className="charts"><ActivityChart kind="activity" buckets={buckets}/><ActivityChart kind="accuracy" buckets={buckets}/></div>
    <section className="analysis-card">
      <h2>Аналитика обучения</h2>
      <div className="tools">
        <div className="actions" role="group" aria-label="Группировка статистики">
          <button aria-pressed={view==='sections'} onClick={()=>setView('sections')}>Разделы</button>
          <button aria-pressed={view==='mechanisms'} onClick={()=>setView('mechanisms')}>Механизмы</button>
        </div>
        <select aria-label="Метрика точности" value={metric} onChange={e=>setMetric(e.target.value as Metric)}>
          {Object.entries(metricNames).map(([key,label])=><option key={key} value={key}>{label}</option>)}
        </select>
      </div>
      {view==='mechanisms'&&<div className="tools">
        <select aria-label="Найти вопросы по механизму" value={tag} onChange={e=>setTag(e.target.value)}>
          <option value="">Поиск по механизму</option>
          {groups.mechanisms.filter(g=>g.questionIds.size).map(g=><option key={g.id} value={g.id}>{g.title} ({g.questionIds.size})</option>)}
        </select>
        <button disabled={!selected} onClick={()=>selected&&openGroup(selected)}>Открыть вопросы</button>
      </div>}
      {rows.length?<div className="analytics-table-wrap"><table className="analytics-table">
        <thead><tr><th scope="col">{view==='sections'?'Раздел':'Механизм'}</th><th scope="col">Вопросов</th><th scope="col">Изучено</th><th scope="col">С ошибками</th><th scope="col">Первые</th><th scope="col">Повторы</th><th scope="col">{metricNames[metric]}</th><th scope="col">Охват</th></tr></thead>
        <tbody>{rows.map(row=>{
          const parent=mechanismById.get(row.group.id)?.parent
          const parentTitle=parent&&mechanismById.get(parent)?.title
          return <tr key={row.group.id}>
            <th scope="row"><button onClick={()=>openGroup(row.group)}>{row.group.title}</button>
              {parentTitle&&<small>{parentTitle}</small>}
              {view==='mechanisms'&&row.studied<3&&<small>Мало данных</small>}
            </th>
            <td>{row.size}</td><td>{row.studied}</td><td>{row.mistakes}</td>
            <td>{formatRate(accuracy(row.metrics.first))}</td><td>{formatRate(accuracy(row.metrics.repeat))}</td>
            <td>{formatRate(accuracy(metricCounts(row.metrics,metric)))}</td>
            <td>{row.size?Math.round(row.studied*100/row.size):0}%</td>
          </tr>
        })}</tbody>
      </table></div>:<p className="muted">Нет групп для анализа.</p>}
      {view==='mechanisms'&&<p className="muted small">В таблице темы от 6 уникальных вопросов. Поиск доступен и для редких тегов.</p>}
    </section>
  </div>
}
