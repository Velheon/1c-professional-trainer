import type { Question } from './model'
// Display order only: leave the imported source array, UUIDs and answer keys intact.
export function displayAnswers(question:Question) {
  return [...question.answers].sort((a,b)=>a.answer_code-b.answer_code)
}
