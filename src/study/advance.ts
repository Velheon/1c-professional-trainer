import { db } from '../storage/db'
import { type Session } from '../domain/model'
import { currentId, updateSession } from './service'
import { deriveReview, pickEmbedded } from './planner'
export async function advance(session:Session,now=new Date(),database=db) {
  const id=currentId(session)
  const recent=[...session.recent_ids,id].slice(-12)
  if(session.inserted_review_id) return updateSession(session,{inserted_review_id:null,recent_ids:recent,new_since_review:0},database)
  if(session.cursor>=session.question_ids.length-1) return updateSession(session,{status:'completed',recent_ids:recent},database)
  const attempts=await database.attempts.toArray()
  const annotations=await database.annotations.toArray()
  const first=attempts.filter(a=>a.question_id===id).sort((a,b)=>a.answered_at.localeCompare(b.answered_at)||a.attempt_id.localeCompare(b.attempt_id))[0]
  const newlyAnswered=first?.session_id===session.session_id && !(session.counted_new_ids??[]).includes(id)
  const counted=newlyAnswered?[...(session.counted_new_ids??[]),id]:(session.counted_new_ids??[])
  const since=session.new_since_review+Number(newlyAnswered)
  const review=session.mode==='sequential'?pickEmbedded(deriveReview(attempts,annotations),now,recent,since):undefined
  return updateSession(session,{cursor:session.cursor+1,recent_ids:recent,new_since_review:since,counted_new_ids:counted,inserted_review_id:review??null},database)
}
