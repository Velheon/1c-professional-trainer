import { z } from 'zod'
import type { Annotation, Attempt, Flag, Session } from '../domain/model'
export type MutableKind='session'|'flag'|'preferences'|'active'
export type EventKind=MutableKind|'attempt'|'annotation'
export type Payload=Attempt|Annotation|Session|Flag|{theme:'dark'|'light'|'system'}|{session_id:string|null}
export interface Outbox {key:string;event_id:string;user_id:string;kind:EventKind;entity_id:string;payload:Payload;created_at:string}
export interface RemoteState {user_id:string;kind:MutableKind;entity_id:string;version:number;event_id:string;payload:Payload;updated_at:string}
export interface Head {key:string;version:number;event_id:string}
export interface Conflict {key:string;local:Outbox;remote:RemoteState;detected_at:string}
export interface Binding {user_id:string;project_url:string;signed_out:boolean}
const uuid=z.uuid(), utc=z.iso.datetime({offset:true})
export const attemptSchema=z.object({attempt_id:uuid,user_id:uuid,question_id:uuid,answer_id:uuid,is_correct:z.boolean(),is_unsure:z.boolean(),answered_at:utc,session_id:uuid,device_id:uuid,mode:z.enum(['sequential','random','review','exam'])})
export const annotationSchema=z.object({event_id:uuid,user_id:uuid,attempt_id:uuid,is_unsure:z.boolean(),changed_at:utc,device_id:uuid})
export const sessionSchema=z.object({
  session_id:uuid,user_id:uuid,device_id:uuid,mode:z.enum(['sequential','random','review','exam']),section_id:uuid.nullable(),
  question_ids:z.array(uuid).min(1),cursor:z.number().int().nonnegative(),choices:z.record(uuid,uuid),unsure_choices:z.record(uuid,z.boolean()).optional(),retry_ids:z.array(uuid),
  version:z.number().int().positive(),status:z.enum(['active','paused','completed']),updated_at:utc,
  new_since_review:z.number().int().nonnegative(),counted_new_ids:z.array(uuid),recent_ids:z.array(uuid),inserted_review_id:uuid.nullable(),
  exam:z.object({started_at:utc,deadline_at:utc,finished_at:utc.optional(),choice_times:z.record(uuid,utc)}).optional(),
}).refine(s=>s.cursor<s.question_ids.length&&new Set(s.question_ids).size===s.question_ids.length,'Некорректная позиция сессии')
  .refine(s=>{
    if(s.mode!=='exam')return !s.exam
    const e=s.exam
    if(!e||s.question_ids.length!==14||s.inserted_review_id||s.retry_ids.length||Date.parse(e.deadline_at)-Date.parse(e.started_at)!==30*60_000)return false
    const selected=Object.keys(s.choices),times=Object.entries(e.choice_times)
    return selected.every(id=>s.question_ids.includes(id))&&times.length===selected.length&&times.every(([id,time])=>selected.includes(id)&&Date.parse(time)>=Date.parse(e.started_at)&&Date.parse(time)<Date.parse(e.deadline_at))&&
      (s.status==='completed'?!!e.finished_at&&Date.parse(e.finished_at)>=Date.parse(e.started_at)&&Date.parse(e.finished_at)<=Date.parse(e.deadline_at):!e.finished_at)
  },'Некорректные параметры экзамена')
const flagSchema=z.object({question_id:uuid,user_id:uuid,bookmarked:z.boolean(),skipped:z.boolean(),updated_at:utc})
export function validatePayload(kind:MutableKind,value:unknown):Payload {
  if(kind==='session')return sessionSchema.parse(value)
  if(kind==='flag')return flagSchema.parse(value)
  if(kind==='preferences')return z.object({theme:z.enum(['dark','light','system'])}).parse(value)
  return z.object({session_id:uuid.nullable()}).parse(value)
}
export function keyOf(kind:EventKind,id:string) {return `${kind}:${id}`}
export function canonical(value:unknown):string {
  if(value===undefined)return 'null'
  if(value===null||typeof value!=='object')return JSON.stringify(value)
  if(Array.isArray(value))return '['+value.map(canonical).join(',')+']'
  const obj=value as Record<string,unknown>
  return '{'+Object.keys(obj).sort().map(k=>JSON.stringify(k)+':'+canonical(obj[k])).join(',')+'}'
}
