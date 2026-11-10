import { expect, it } from 'vitest'
import { accuracy, activityBuckets, buildStatistics, dayKey, metricCounts, summarize } from '../src/analytics/statistics'
import { classify, mechanismIds, classificationSchema } from '../src/analytics/mechanisms'
import { allowsOffline, OFFLINE_ACCESS_MS } from '../src/cloud/access'
import type { Attempt } from '../src/domain/model'
import { demoBank } from './fixtures'

function attempt(id:string,q:string,day:number,correct:boolean,mode:Attempt['mode']='sequential'):Attempt {
  return {attempt_id:id,question_id:q,user_id:'owner',answer_id:'answer',device_id:'device',
    session_id:'session',mode,is_correct:correct,is_unsure:false,answered_at:new Date(2026,10,day,12).toISOString()}
}

it('uses the first answer across all history and counts later attempts in the local calendar',()=>{
  const original=attempt('1','a',1,false),repeat=attempt('2','a',10,true,'review')
  const stats=buildStatistics([repeat,attempt('3','b',10,true),original,repeat,attempt('4','c',10,true,'exam')])
  const today=stats.days.get(dayKey(new Date(2026,10,10)))!
  expect(today).toEqual({first:{correct:1,wrong:0},repeat:{correct:1,wrong:0}})
  const group=summarize(['a','a','b','c'],stats)
  expect(group).toMatchObject({size:3,studied:2,mistakes:1})
  expect(accuracy(group.metrics.first)).toBe(50)
  expect(accuracy(group.metrics.repeat)).toBe(100)
  expect(accuracy(metricCounts(group.metrics,'all'))).toBe(67)
  expect(stats.history.get('c')).toHaveLength(1)
  const week=activityBuckets(stats,'week',new Date(2026,10,10))
  expect(week).toHaveLength(7)
  expect(accuracy(metricCounts(week[0].metrics,'all'))).toBeNull()
  expect(activityBuckets(stats,'month',new Date(2026,10,10))).toHaveLength(30)
  expect(activityBuckets(stats,'all',new Date(2026,10,10))).toHaveLength(1)
})

it('classifies subject-specific text and deduplicates a parent included via two children',()=>{
  const q={...demoBank.questions[0],text:'Как настроить срез последних регистра сведений?'}
  expect(classify(q).primary).toBe('information_registers')
  expect([...mechanismIds({primary:'information_registers',additional:['accumulation','registers']})].sort())
    .toEqual(['accumulation','information_registers','registers'])
  expect(classificationSchema.safeParse({primary:'forms',additional:['forms']}).success).toBe(false)
})

it('offline access is limited to the verified owner, cached bank, project and validity window',()=>{
  const binding={user_id:'a',project_url:'project',signed_out:false}
  const lease={user_id:'a',project_url:'project',verified_at:1000}
  expect(allowsOffline(binding,lease,'a','project',null,1001)).toBe(true)
  expect(allowsOffline(binding,lease,'a','project','b',1001)).toBe(false)
  expect(allowsOffline(binding,lease,'a','project',null,1000+OFFLINE_ACCESS_MS)).toBe(false)
  expect(allowsOffline(binding,undefined,'a','project','a',1001)).toBe(false)
  expect(allowsOffline({...binding,signed_out:true},lease,'a','project','a',1001)).toBe(false)
  expect(allowsOffline(binding,lease,undefined,'project','a',1001)).toBe(false)
})
