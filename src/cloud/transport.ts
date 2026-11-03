import type { SupabaseClient } from '@supabase/supabase-js'
import type { SyncTransport } from '../sync/engine'
import { annotationSchema, attemptSchema, canonical, validatePayload, type MutableKind, type Outbox, type RemoteState } from '../sync/model'
import { z } from 'zod'
const remoteSchema=z.object({user_id:z.uuid(),kind:z.enum(['session','flag','preferences','active']),entity_id:z.string(),version:z.coerce.number().int().positive(),event_id:z.uuid(),payload:z.unknown(),updated_at:z.string()})
function parseState(value:unknown):RemoteState {
  const state=remoteSchema.parse(value)
  return {...state,payload:validatePayload(state.kind,state.payload)}
}
function normalizeImmutable(kind:'attempt'|'annotation',value:unknown) {
  if(kind==='attempt'){const a=attemptSchema.parse(value);return {...a,answered_at:new Date(a.answered_at).toISOString()}}
  const a=annotationSchema.parse(value);return {...a,changed_at:new Date(a.changed_at).toISOString()}
}
export class SupabaseTransport implements SyncTransport {
  constructor(private client:SupabaseClient,private user_id:string){}
  private async all(table:string,order:string) {
    const rows:unknown[]=[]
    for(let from=0;;from+=1000) {
      const {data,error}=await this.client.from(table).select('*').eq('user_id',this.user_id).order(order).range(from,from+999)
      if(error)throw error
      rows.push(...data)
      if(data.length<1000)return rows
    }
  }
  async attempts(){return (await this.all('attempts','attempt_id')).map(v=>normalizeImmutable('attempt',v))}
  async annotations(){return (await this.all('attempt_annotations','event_id')).map(v=>normalizeImmutable('annotation',v))}
  async states(){return (await this.all('user_sync_state','entity_id')).map(parseState)}
  async putImmutable(event:Outbox) {
    const kind=event.kind==='attempt'?'attempt':'annotation'
    const table=kind==='attempt'?'attempts':'attempt_annotations',id=kind==='attempt'?'attempt_id':'event_id'
    const record:Record<string,unknown>={...event.payload}
    const {error}=await this.client.from(table).upsert(record,{onConflict:id,ignoreDuplicates:true})
    if(error)throw error
    const result=await this.client.from(table).select('*').eq(id,event.entity_id).eq('user_id',this.user_id).single()
    if(result.error)throw result.error
    if(canonical(normalizeImmutable(kind,result.data))!==canonical(event.payload))throw new Error('UUID события уже занят другими данными; история не перезаписана')
  }
  async putState(event:Outbox,expectedVersion:number) {
    const {data,error}=await this.client.rpc('save_sync_state',{p_kind:event.kind,p_entity_id:event.entity_id,p_expected_version:expectedVersion,p_event_id:event.event_id,p_payload:event.payload})
    if(error)throw error
    const version=Number(data)
    if(!Number.isSafeInteger(version)||version<1)throw new Error('Некорректная версия после сохранения')
    return version
  }
  async state(kind:MutableKind,id:string) {
    const {data,error}=await this.client.from('user_sync_state').select('*').eq('user_id',this.user_id).eq('kind',kind).eq('entity_id',id).maybeSingle()
    if(error)throw error
    return data?parseState(data):null
  }
}
