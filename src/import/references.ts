import type { Question } from '../domain/model'
export function answerReferences(text:string):number[] {
  return [...text.matchAll(/вариант(?:ы|ов|а)?\s+((?:\d+\s*(?:и\/или|и|или|,|\/)?\s*)+)/gi)]
    .flatMap(m=>(m[1].match(/\d+/g)??[]).map(Number))
}
export function validateAnswerNumbers(q:Question) {
  const codes=q.answers.map(a=>a.answer_code)
  if(new Set(codes).size!==codes.length||codes.some(n=>!Number.isSafeInteger(n)||n<1))throw new Error('Неоднозначные исходные номера вариантов')
  for(const a of q.answers)for(const n of answerReferences(a.text))if(!codes.includes(n))throw new Error('Составной ответ ссылается на отсутствующий исходный номер')
}
