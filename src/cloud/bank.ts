import type { SupabaseClient } from '@supabase/supabase-js'
import { z } from 'zod'
import { importBank, type TrainerDB } from '../storage/db'
import { validateBank } from '../import/archive'
import { canonical } from '../sync/model'
import type { ImportReport, StoredImage } from '../domain/model'
const manifestSchema=z.array(z.object({path:z.string().regex(/^images\/png\/[a-f0-9-]+(?:_\d+)?\.png$/),question_id:z.uuid(),sha256:z.string().regex(/^[a-f0-9]{64}$/)}))
const reportSchema=z.object({sha256:z.string().regex(/^[a-f0-9]{64}$/),sections:z.number().int(),questions:z.number().int(),answers:z.number().int(),images:z.number().int(),warnings:z.array(z.string()),content_sha256:z.string().regex(/^[a-f0-9]{64}$/)})
async function digest(bytes:ArrayBuffer){return [...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(b=>b.toString(16).padStart(2,'0')).join('')}
const contentHash=(source:unknown)=>digest(new TextEncoder().encode(canonical(source)).buffer)
export async function ensureCloudBank(database:TrainerDB,client:SupabaseClient,user_id:string,progress:(message:string)=>void) {
  if((await database.meta.get('cloudBankReady'))?.value===user_id)return
  progress('Проверяем закрытый банк вопросов…')
  const remote=await client.from('bank_source').select('source,report').eq('bank_id',1).maybeSingle()
  if(remote.error)throw remote.error
  if(remote.data) {
    const source=validateBank(remote.data.source)
    const report=reportSchema.parse(remote.data.report)
    if(await contentHash(remote.data.source)!==report.content_sha256)throw new Error('Не совпала контрольная сумма облачного банка')
    const manifest=manifestSchema.parse(source.image_manifest)
    const expected=source.questions.flatMap(q=>q.image_pngs.map(path=>({path,question_id:q.question_id})))
    if(manifest.length!==expected.length||new Set(manifest.map(i=>i.path)).size!==manifest.length||expected.some(i=>!manifest.some(m=>m.path===i.path&&m.question_id===i.question_id)))throw new Error('Облачные иллюстрации не соответствуют вопросам')
    const images:StoredImage[]=[]
    for(const [index,m] of manifest.entries()) {
      progress(`Загружаем иллюстрации: ${index+1} / ${manifest.length}`)
      let blob=(await database.images.get(m.path))?.blob
      if(!blob||await digest(await blob.arrayBuffer())!==m.sha256) {
        const downloaded=await client.storage.from('question-images').download(m.path)
        if(downloaded.error)throw downloaded.error
        blob=downloaded.data
      }
      if(await digest(await blob.arrayBuffer())!==m.sha256)throw new Error('Повреждена облачная иллюстрация')
      if(typeof createImageBitmap==='function'){const img=await createImageBitmap(blob);img.close()}
      images.push({path:m.path,question_id:m.question_id,blob})
    }
    if(report.sections!==source.sections.length||report.questions!==source.questions.length||report.answers!==source.questions.reduce((n,q)=>n+q.answers.length,0)||report.images!==new Set(images.map(i=>i.question_id)).size)throw new Error('Не совпали счётчики облачного банка')
    await importBank(source,images,report,database)
  } else {
    const sections=await database.sections.orderBy('section_order').toArray()
    const questions=(await database.questions.toArray()).sort((a,b)=>a.section_order-b.section_order||a.question_order-b.question_order)
    const images=await database.images.toArray()
    const report=(await database.meta.get('import'))?.value as ImportReport|undefined
    if(!sections.length||!report)throw new Error('В облаке пока нет банка. Импортируйте свой ZIP на этом устройстве и повторите синхронизацию.')
    const image_manifest=await Promise.all(images.map(async image=>({path:image.path,question_id:image.question_id,sha256:await digest(await image.blob.arrayBuffer())})))
    const source=validateBank({sections,questions,image_manifest})
    const referenced=questions.flatMap(q=>q.image_pngs)
    if(referenced.length!==images.length||referenced.some(path=>!images.some(i=>i.path===path)))throw new Error('В локальном банке не хватает иллюстраций')
    const installed=await client.rpc('install_bank',{p_source:source,p_report:{...report,content_sha256:await contentHash(source)}})
    if(installed.error)throw installed.error
    for(const [index,image] of images.entries()) {
      progress(`Сохраняем приватные иллюстрации: ${index+1} / ${images.length}`)
      const uploaded=await client.storage.from('question-images').upload(image.path,image.blob,{upsert:false,contentType:'image/png'})
      if(uploaded.error) {
        const existing=await client.storage.from('question-images').download(image.path)
        if(existing.error||await digest(await existing.data.arrayBuffer())!==image_manifest[index].sha256)throw uploaded.error
      }
    }
  }
  await database.meta.put({key:'cloudBankReady',value:user_id})
}
