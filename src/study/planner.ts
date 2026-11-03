import { compareEvents, type Annotation, type Attempt, type Question } from '../domain/model'
import { effectiveUnsure } from '../domain/model'
export interface ReviewState {
  question_id:string; ever_answered:boolean; last_answer_correct:boolean; confidence:boolean;
  review_stage:number; due_at:string; mastered:boolean; problematic:boolean; last_attempt:Attempt;
}
const DAY=86_400_000
export const INTERVAL_DAYS=[1,3,7,14,30,60]
export function deriveReview(attempts:Attempt[],annotations:Annotation[]):Map<string,ReviewState> {
  const result=new Map<string,ReviewState>()
  for(const a of [...attempts].filter(a=>a.mode!=='exam').sort(compareEvents)) {
    const previous=result.get(a.question_id)
    const unsure=effectiveUnsure(a,annotations)
    const stage=!a.is_correct?0:unsure?(previous?.review_stage??0):Math.min((previous?.review_stage??0)+1,INTERVAL_DAYS.length)
    const interval=!a.is_correct?0:unsure?Math.min(INTERVAL_DAYS[Math.max(0,stage-1)],1):INTERVAL_DAYS[stage-1]
    result.set(a.question_id,{question_id:a.question_id,ever_answered:true,last_answer_correct:a.is_correct,confidence:!unsure,
      review_stage:stage,due_at:new Date(Date.parse(a.answered_at)+interval*DAY).toISOString(),mastered:stage>=4 && a.is_correct && !unsure,
      problematic:!a.is_correct||unsure,last_attempt:a})
  }
  return result
}
export function dueQuestions(states:Map<string,ReviewState>,now:Date):ReviewState[] {
  return [...states.values()].filter(s=>Date.parse(s.due_at)<=now.getTime()).sort((a,b)=>
    a.due_at.localeCompare(b.due_at) || Number(b.problematic)-Number(a.problematic) || a.question_id.localeCompare(b.question_id))
}
export function adaptiveInterval(dueCount:number,errorRate:number) {return dueCount>20||errorRate>=0.35?3:dueCount<5?8:6}
export function pickEmbedded(states:Map<string,ReviewState>,now:Date,recent:string[],since:number):string|undefined {
  const due=dueQuestions(states,now)
  const errors=[...states.values()].filter(s=>s.problematic).length/Math.max(states.size,1)
  const interval=adaptiveInterval(due.length,errors)
  if(since<interval) return
  // Fresh mistakes must have at least 5 other displayed questions before resurfacing.
  return due.find(s=>!recent.slice(-6).includes(s.question_id))?.question_id
}
export type RandomFilter='solved'|'new'|'all'|'problematic'
export function randomSelection(questions:Question[],states:Map<string,ReviewState>,filter:RandomFilter,size:number|'all',rng:()=>number):string[] {
  const ids=questions.filter(q=>filter==='all'||filter==='solved'&&states.has(q.question_id)||filter==='new'&&!states.has(q.question_id)||filter==='problematic'&&states.get(q.question_id)?.problematic).map(q=>q.question_id)
  for(let i=ids.length-1;i>0;i--) {const value=rng();if(value<0||value>=1)throw new Error('Генератор должен возвращать число от 0 до 1');const j=Math.floor(value*(i+1));[ids[i],ids[j]]=[ids[j],ids[i]]}
  return ids.slice(0,size==='all'?ids.length:size)
}
export function secureRandom() {return crypto.getRandomValues(new Uint32Array(1))[0]/4294967296}
