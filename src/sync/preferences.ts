import { db, profile, type TrainerDB } from '../storage/db'
import { enqueue } from './queue'
export async function setTheme(theme:'dark'|'light'|'system',database:TrainerDB=db) {
  await database.transaction('rw',[database.meta,database.outbox],async()=> {
    const p=await profile(database)
    await database.meta.put({key:'theme',value:theme})
    await enqueue(database,'preferences','theme',p.id,{theme})
  })
}
