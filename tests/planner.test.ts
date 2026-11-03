import { describe, expect, it } from 'vitest'
import { deriveReview, randomSelection, dueQuestions, pickEmbedded, adaptiveInterval } from '../src/study/planner'
import type { Annotation, Attempt, Question } from '../src/domain/model'
const start='2026-11-03T10:00:00.000Z'
const attempt=(id:string,question_id:string,is_correct=true,is_unsure=false,date=start):Attempt=> ({
  attempt_id:id,question_id,answer_id:'answer',user_id:'user',is_correct,is_unsure,answered_at:date,session_id:'session',device_id:'device',mode:'sequential',
})
describe('Review scheduler',()=> {
  it('progresses 1/3/7/14 days, marks mastered only after several confident successes',()=> {
    const history:Attempt[]=[]
    for(const [i,day] of [1,3,7,14].entries()) {
      history.push(attempt(String(i),'q',true,false,new Date(Date.parse(start)+i*864e5).toISOString()))
      const state=deriveReview(history,[]).get('q')!
      expect(Date.parse(state.due_at)-Date.parse(history[i].answered_at)).toBe(day*864e5)
      expect(state.mastered).toBe(i===3)
    }
  })
  it('a new error resets review while preserving coverage; unsure does not promote',()=> {
    const history=[attempt('1','q'),attempt('2','q',true,false,'2026-11-04T10:00:00.000Z'),attempt('3','q',false,false,'2026-11-05T10:00:00.000Z')]
    let state=deriveReview(history,[]).get('q')!
    expect(state.ever_answered).toBe(true);expect(state.review_stage).toBe(0);expect(state.problematic).toBe(true)
    history.push(attempt('4','q',true,true,'2026-11-06T10:00:00.000Z'))
    state=deriveReview(history,[]).get('q')!
    expect(state.review_stage).toBe(0);expect(state.mastered).toBe(false)
  })
  it('recomputes annotations, ignores exams, and uses UTC boundaries',()=> {
    const a=attempt('1','q')
    const annotation:Annotation={event_id:'event',attempt_id:'1',user_id:'user',device_id:'device',changed_at:start,is_unsure:true}
    const states=deriveReview([a,{...attempt('2','exam'),mode:'exam'}],[annotation])
    expect(states.size).toBe(1);expect(states.get('q')?.review_stage).toBe(0)
    expect(dueQuestions(states,new Date('2026-11-04T09:59:59.999Z'))).toHaveLength(0)
    expect(dueQuestions(states,new Date('2026-11-04T10:00:00.000Z'))).toHaveLength(1)
  })
  it('does not invent repetitions; respects recent questions and adaptive intervals',()=> {
    const now=new Date(start),states=deriveReview([attempt('1','bad',false)],[])
    expect(pickEmbedded(new Map(),now,[],100)).toBeUndefined()
    expect(pickEmbedded(states,now,['bad'],10)).toBeUndefined()
    expect(pickEmbedded(states,now,['1','2','3','4','5','6'],5)).toBe('bad')
    expect(pickEmbedded(states,now,[],1)).toBeUndefined()
    expect(adaptiveInterval(30,0)).toBe(3);expect(adaptiveInterval(0,0)).toBe(8)
  })
})
describe('Random selection',()=> {
  const questions=['a','b','c','d'].map(question_id=>({question_id}) as Question)
  const states=deriveReview([attempt('1','a'),attempt('2','b',false),attempt('3','c',true,true)],[])
  for(const [filter,expected] of [['solved',['a','b','c']],['new',['d']],['all',['a','b','c','d']],['problematic',['b','c']]] as const) {
    it(`filters ${filter}, caps size and never duplicates`,()=> {
      const selected=randomSelection(questions,states,filter,20,()=>0.5)
      expect(selected.sort()).toEqual([...expected]);expect(selected.length).toBe(new Set(selected).size)
    })
  }
  it('is reproducible with an injected random source',()=> {
    const seed=()=> {let n=7;return ()=> {n=(n*16807)%2147483647;return (n-1)/2147483646}}
    expect(randomSelection(questions,states,'all','all',seed())).toEqual(randomSelection(questions,states,'all','all',seed()))
  })
})
