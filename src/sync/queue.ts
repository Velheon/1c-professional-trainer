import type { TrainerDB } from '../storage/db'
import { keyOf, type EventKind, type Payload } from './model'
export async function enqueue(database:TrainerDB,kind:EventKind,id:string,user_id:string,payload:Payload) {
  await database.outbox.put({key:keyOf(kind,id),kind,entity_id:id,user_id,payload:structuredClone(payload),event_id:crypto.randomUUID(),created_at:new Date().toISOString()})
}
