import { z } from 'zod'
const id = z.uuid()
const order = z.number().int().positive()
export const answerSchema = z.object({
  answer_id: id, answer_order: order, answer_code: z.number().int(),
  text: z.string().min(1), is_correct: z.boolean(), deleted: z.boolean(),
}).passthrough()
export const sectionSchema = z.object({
  section_id: id, section_order: order, section_code: z.number().int(),
  section_title: z.string().min(1), question_count: z.number().int().nonnegative(),
}).passthrough()
export const questionSchema = z.object({
  question_id: id, section_id: id, section_order: order, section_title: z.string(),
  question_order: order, question_code: z.number().int(), text: z.string().min(1),
  explanation: z.string(), explanation_url: z.string(), keep_answer_order: z.boolean(),
  disabled: z.boolean(), deleted: z.boolean(), updated_at: z.string(),
  image_attached: z.boolean(), comment_archive_attached: z.boolean(),
  image_original: z.string(), image_pngs: z.array(z.string()), answers: z.array(answerSchema).min(1),
}).passthrough()
export const bankSchema = z.object({ sections: z.array(sectionSchema).min(1), questions: z.array(questionSchema).min(1) }).passthrough()
export type Answer = z.infer<typeof answerSchema>
export type Section = z.infer<typeof sectionSchema>
export type Question = z.infer<typeof questionSchema>
export type Bank = z.infer<typeof bankSchema>
export type Mode = 'sequential' | 'random' | 'review' | 'exam'
export interface Profile { id: string; device_id: string }
export interface Attempt {
  attempt_id: string; user_id: string; question_id: string; answer_id: string;
  is_correct: boolean; is_unsure: boolean; answered_at: string;
  session_id: string; mode: Mode; device_id: string;
}
export interface Annotation {
  event_id: string; attempt_id: string; user_id: string; is_unsure: boolean;
  changed_at: string; device_id: string;
}
export interface Session {
  session_id: string; user_id: string; device_id: string; mode: Mode; section_id: string | null;
  question_ids: string[]; cursor: number; choices: Record<string,string>; unsure_choices?: Record<string,boolean>; retry_ids: string[];
  version: number; status: 'active'|'paused'|'completed'; updated_at: string;
  // Sequential progress is independent from inserted review questions.
  new_since_review: number; counted_new_ids: string[]; recent_ids: string[]; inserted_review_id: string | null;
  exam?: {started_at:string;deadline_at:string;finished_at?:string;choice_times:Record<string,string>};
}
export interface Flag { question_id: string; user_id: string; bookmarked: boolean; skipped: boolean; updated_at: string }
export interface StoredImage { path: string; question_id: string; blob: Blob }
export interface ImportReport { sha256: string; sections: number; questions: number; answers: number; images: number; warnings: string[] }
export function safeUrl(value: string): string | undefined {
  try { const u = new URL(value); return ['http:', 'https:'].includes(u.protocol) && !u.username && !u.password ? u.href : undefined }
  catch { return undefined }
}
export function compareEvents(a: { answered_at: string; attempt_id: string }, b: { answered_at: string; attempt_id: string }) {
  return a.answered_at.localeCompare(b.answered_at) || a.attempt_id.localeCompare(b.attempt_id)
}

export function effectiveUnsure(attempt:Attempt, annotations:Annotation[]) {
  return annotations.filter(a=>a.attempt_id===attempt.attempt_id).sort((a,b)=>a.changed_at.localeCompare(b.changed_at)||a.event_id.localeCompare(b.event_id)).at(-1)?.is_unsure ?? attempt.is_unsure
}
