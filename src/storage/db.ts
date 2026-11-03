import Dexie, { type EntityTable } from 'dexie'
import type { Annotation, Attempt, Flag, ImportReport, Profile, Question, Section, Session, StoredImage } from '../domain/model'
import { canonical, type Conflict, type Head, type Outbox } from '../sync/model'
export class TrainerDB extends Dexie {
  sections!: EntityTable<Section,'section_id'>
  questions!: EntityTable<Question,'question_id'>
  images!: EntityTable<StoredImage,'path'>
  attempts!: EntityTable<Attempt,'attempt_id'>
  annotations!: EntityTable<Annotation,'event_id'>
  sessions!: EntityTable<Session,'session_id'>
  flags!: EntityTable<Flag,'question_id'>
  meta!: EntityTable<{key:string; value:unknown},'key'>
  outbox!: EntityTable<Outbox,'key'>
  syncHeads!: EntityTable<Head,'key'>
  conflicts!: EntityTable<Conflict,'key'>
  constructor(name='1c-professional-trainer') {
    super(name)
    this.version(1).stores({
      sections:'section_id,section_order', questions:'question_id,section_id,[section_id+question_order]',
      images:'path,question_id', attempts:'attempt_id,question_id,session_id,answered_at',
      annotations:'event_id,attempt_id', sessions:'session_id,status,updated_at',
      flags:'question_id', meta:'key',
    })
    this.version(2).stores({outbox:'key,user_id,kind,created_at',syncHeads:'key',conflicts:'key'})
  }
}
export const db = new TrainerDB()
export async function profile(database=db): Promise<Profile> {
  return database.transaction('rw',database.meta,async()=> {
    const existing = await database.meta.get('profile')
    if (existing) return existing.value as Profile
    const value = {id:crypto.randomUUID(),device_id:crypto.randomUUID()}
    await database.meta.add({key:'profile',value}); return value
  })
}
export async function importBank(bank: {sections:Section[]; questions:Question[]}, images:StoredImage[], report:ImportReport, database=db) {
  return database.transaction('rw',[database.sections,database.questions,database.images,database.meta],async()=> {
    const previous = await database.meta.get('import')
    const unchanged=(previous?.value as ImportReport | undefined)?.sha256===report.sha256
    const existing = await database.questions.toArray()
    const byId = new Map(bank.questions.map(q=>[q.question_id,q]))
    for (const old of existing) {
      if (canonical(old) !== canonical(byId.get(old.question_id))) throw new Error('Новая версия меняет или удаляет существующий вопрос. Нужна отдельная проверка изменений; история сохранена.')
    }
    await database.sections.bulkPut(bank.sections)
    await database.questions.bulkPut(bank.questions)
    await database.images.bulkPut(images)
    await database.meta.put({key:'import',value:report})
    if(!unchanged)await database.meta.delete('cloudBankReady')
    return unchanged?'unchanged':'imported'
  })
}
