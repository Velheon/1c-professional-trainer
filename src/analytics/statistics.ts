import { compareEvents, type Attempt } from '../domain/model'

export interface Counts { correct:number; wrong:number }
export interface Metrics {
  first:Counts
  repeat:Counts
}
export type Period='week'|'month'|'all'
export type Metric='first'|'repeat'|'all'
export const emptyMetrics=():Metrics=>({first:{correct:0,wrong:0},repeat:{correct:0,wrong:0}})
export function total(counts:Counts){return counts.correct+counts.wrong}
export function metricCounts(m:Metrics,metric:Metric):Counts {
  if(metric!=='all')return m[metric]
  return {correct:m.first.correct+m.repeat.correct,wrong:m.first.wrong+m.repeat.wrong}
}
export function accuracy(counts:Counts) {
  return total(counts)?Math.round(counts.correct*100/total(counts)):null
}
const two=(n:number)=>String(n).padStart(2,'0')
export function dayKey(date:Date) {
  return `${date.getFullYear()}-${two(date.getMonth()+1)}-${two(date.getDate())}`
}

export function buildStatistics(attempts:Attempt[]) {
  const questions=new Map<string,Metrics>(),days=new Map<string,Metrics>(),months=new Map<string,Metrics>()
  const history=new Map<string,Attempt[]>()
  const seen=new Set<string>()
  function add(map:Map<string,Metrics>,id:string,kind:'first'|'repeat',correct:boolean) {
    const m=map.get(id)??emptyMetrics()
    m[kind][correct?'correct':'wrong']++
    map.set(id,m)
  }
  for(const attempt of [...attempts].sort(compareEvents)) {
    if(seen.has(attempt.attempt_id))continue
    seen.add(attempt.attempt_id)
    const list=history.get(attempt.question_id)??[]
    list.push(attempt)
    history.set(attempt.question_id,list)
    if(attempt.mode==='exam')continue
    const kind=questions.has(attempt.question_id)?'repeat':'first'
    const day=dayKey(new Date(attempt.answered_at))
    add(questions,attempt.question_id,kind,attempt.is_correct)
    add(days,day,kind,attempt.is_correct)
    add(months,day.slice(0,7),kind,attempt.is_correct)
  }
  return {questions,days,months,history}
}
export type Statistics=ReturnType<typeof buildStatistics>

export function summarize(ids:Iterable<string>,stats:Statistics) {
  const unique=new Set(ids),metrics=emptyMetrics()
  let studied=0,mistakes=0
  for(const id of unique) {
    const m=stats.questions.get(id)
    if(!m)continue
    studied++
    if(m.first.wrong||m.repeat.wrong)mistakes++
    for(const kind of ['first','repeat'] as const) {
      metrics[kind].correct+=m[kind].correct
      metrics[kind].wrong+=m[kind].wrong
    }
  }
  return {size:unique.size,studied,mistakes,metrics}
}

export function activityBuckets(stats:Statistics,period:Period,now:Date) {
  const buckets:{key:string;label:string;metrics:Metrics}[]=[]
  const dayFormat=new Intl.DateTimeFormat('ru-RU',{day:'numeric',month:'short'})
  const monthFormat=new Intl.DateTimeFormat('ru-RU',{month:'short',year:'2-digit'})
  if(period==='all') {
    const end=dayKey(now).slice(0,7)
    const first=[...stats.months.keys()].filter(key=>key<=end).sort()[0]
    if(!first)return buckets
    const [year,month]=first.split('-').map(Number)
    for(const date=new Date(year,month-1,1);dayKey(date).slice(0,7)<=end;date.setMonth(date.getMonth()+1)) {
      const key=dayKey(date).slice(0,7)
      buckets.push({key,label:monthFormat.format(date),metrics:stats.months.get(key)??emptyMetrics()})
    }
    return buckets
  }
  const count=period==='week'?7:30
  for(let offset=count-1;offset>=0;offset--) {
    const date=new Date(now.getFullYear(),now.getMonth(),now.getDate()-offset)
    const key=dayKey(date)
    buckets.push({key,label:dayFormat.format(date),metrics:stats.days.get(key)??emptyMetrics()})
  }
  return buckets
}
