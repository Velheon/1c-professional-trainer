import type { Bank } from '../src/domain/model'
// Entirely synthetic, deliberately labelled DEMO. No paid content in this fixture.
const uuid=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`
export const demoBank:Bank={
  sections:[1,2].map(i=>({section_id:uuid(i),section_order:i,section_code:i,section_title:`ДЕМО: раздел ${i}`,question_count:9})),
  questions:Array.from({length:18},(_,i)=> {
    const section=Math.floor(i/9)+1
    return {question_id:uuid(10+i),section_id:uuid(section),section_order:section,section_title:`ДЕМО: раздел ${section}`,
      question_order:i%9+1,question_code:80-i,text:`ДЕМО: синтетический вопрос ${i+1}`,explanation:'ДЕМО: синтетическое пояснение.',explanation_url:'',
      keep_answer_order:true,disabled:false,deleted:false,updated_at:'2026-11-03T00:00:00',image_attached:false,comment_archive_attached:false,image_original:'',image_pngs:[],
      answers:Array.from({length:5},(_,j)=>({answer_id:uuid(100+i*5+j),answer_order:j+1,answer_code:j===3?5:j===4?4:j+1,text:`ДЕМО: вариант ${j+1}`,is_correct:j===4,deleted:false})),
    }
  }),
}
