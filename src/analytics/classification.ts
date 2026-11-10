import { db, profile, type TrainerDB } from '../storage/db'
import { enqueue } from '../sync/queue'
import { classificationSchema, type Classification } from './mechanisms'

export const CLASSIFICATION_PREFIX='classification:'

export async function classifications(database=db) {
  const rows=await database.meta.where('key').startsWith(CLASSIFICATION_PREFIX).toArray()
  return new Map(rows.map(row=>[row.key.slice(CLASSIFICATION_PREFIX.length),classificationSchema.parse(row.value)]))
}

export async function saveClassification(questionId:string,value:Classification,database:TrainerDB=db) {
  const classification=classificationSchema.parse(value)
  await database.transaction('rw',[database.questions,database.meta,database.outbox],async()=>{
    if(!await database.questions.get(questionId))throw new Error('Вопрос не найден')
    const owner=await profile(database)
    await database.meta.put({key:CLASSIFICATION_PREFIX+questionId,value:classification})
    await enqueue(database,'classification',questionId,owner.id,classification)
  })
}
