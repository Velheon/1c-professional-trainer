import { unzip } from 'fflate'
import { z } from 'zod'
import { bankSchema, safeUrl, type Bank, type ImportReport, type StoredImage } from '../domain/model'
const PREFIX = 'platform_83/'
const manifestSchema = z.array(z.object({ question_id: z.uuid(), original_file: z.string(), sha256: z.string(),
  frames: z.array(z.object({ file: z.string(), width: z.number().positive(), height: z.number().positive() })).min(1) }))
export function validateBank(value: unknown): Bank {
  const bank = bankSchema.parse(value)
  const seen = new Set<string>()
  function unique(id: string) { if (seen.has(id)) throw new Error(`Повтор UUID: ${id}`); seen.add(id) }
  bank.sections.forEach((s,i) => { unique(s.section_id); if (s.section_order !== i+1) throw new Error('Нарушен порядок разделов') })
  const sections = new Map(bank.sections.map(s => [s.section_id,s]))
  const cursors = new Map<string, number>()
  let previousSection = 0
  for (const q of bank.questions) {
    unique(q.question_id)
    const s = sections.get(q.section_id)
    const position = (cursors.get(q.section_id) ?? 0)+1
    if (!s || q.section_order !== s.section_order || q.section_title !== s.section_title ||
      q.question_order !== position || q.section_order < previousSection) throw new Error('Нарушены связи или порядок вопросов')
    previousSection = q.section_order; cursors.set(q.section_id,position)
    if (q.disabled || q.deleted || q.answers.some(a=>a.deleted)) throw new Error('Набор содержит отключённые записи: требуется отдельная проверка')
    if (q.answers.filter(a=>a.is_correct).length !== 1) throw new Error('У вопроса должен быть ровно один верный ответ')
    if (q.explanation_url && !safeUrl(q.explanation_url)) throw new Error('Небезопасная ссылка в пояснении')
    for (const [i,a] of q.answers.entries()) { unique(a.answer_id); if (a.answer_order !== i+1) throw new Error('Нарушен порядок ответов') }
  }
  for (const s of bank.sections) if ((cursors.get(s.section_id) ?? 0) !== s.question_count) throw new Error('Не совпадает число вопросов в разделе')
  return bank
}
async function sha(bytes: Uint8Array) {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(bytes).buffer))).map(x=>x.toString(16).padStart(2,'0')).join('')
}
export async function readArchive(bytes: Uint8Array): Promise<{bank: Bank; images: StoredImage[]; report: ImportReport}> {
  if (bytes.length > 40_000_000) throw new Error('Архив больше 40 МБ')
  let total = 0
  const files = await new Promise<Record<string,Uint8Array>>((resolve,reject)=> {
    unzip(bytes, {filter: f=> {
      total += f.originalSize
      if (total > 100_000_000 || f.originalSize > 30_000_000 || f.name.startsWith('/') || f.name.includes('..') || f.name.includes('\\')) {
        reject(new Error('Недопустимый размер или путь в архиве')); return false
      }
      return true
    }}, (err,result)=>err ? reject(err) : resolve(result))
  })
  function get(path: string) { const file = files[PREFIX+path]; if (!file) throw new Error(`Нет файла: ${path}`); return file }
  const json = (path: string): unknown => JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(get(path)))
  const bank = validateBank(json('questions.json'))
  const hashes = z.record(z.string(),z.string().regex(/^[a-f0-9]{64}$/)).parse(json('sha256.json'))
  const actualFiles = Object.keys(files).filter(n=>!n.endsWith('/') && n !== PREFIX+'sha256.json')
  if (actualFiles.length !== Object.keys(hashes).length || actualFiles.some(n=>!(n.slice(PREFIX.length) in hashes))) throw new Error('Неполный список контрольных сумм')
  for (const [name,digest] of Object.entries(hashes)) if (await sha(get(name)) !== digest) throw new Error(`Не совпала контрольная сумма: ${name}`)
  const manifest = manifestSchema.parse(json('images_manifest.json'))
  const images: StoredImage[] = []
  const linked = new Set<string>()
  for (const entry of manifest) {
    const q = bank.questions.find(q=>q.question_id === entry.question_id)
    if (!q?.image_attached || linked.has(entry.question_id) || q.image_original !== entry.original_file ||
      JSON.stringify(q.image_pngs) !== JSON.stringify(entry.frames.map(f=>f.file))) throw new Error('Нарушена привязка иллюстрации')
    linked.add(entry.question_id)
    if (await sha(get(entry.original_file)) !== entry.sha256) throw new Error('Повреждён оригинал иллюстрации')
    for (const frame of entry.frames) {
      const blob = new Blob([new Uint8Array(get(frame.file)).buffer],{type:'image/png'})
      if (typeof createImageBitmap === 'function') {
        const image = await createImageBitmap(blob)
        const valid = image.width === frame.width && image.height === frame.height
        image.close()
        if (!valid) throw new Error('Размер изображения отличается от манифеста')
      }
      images.push({path:frame.file, question_id:q.question_id, blob})
    }
  }
  if (bank.questions.filter(q=>q.image_attached).length !== linked.size) throw new Error('Не хватает изображений')
  const answers = bank.questions.reduce((n,q)=>n+q.answers.length,0)
  const warnings: string[] = []
  if (bank.sections.length !== 14 || bank.questions.length !== 961 || answers !== 4143 || linked.size !== 78) warnings.push('Состав отличается от ожидаемых 14 / 961 / 4143 / 78. Ничего не добавлено искусственно.')
  warnings.push(`Без текста пояснения: ${bank.questions.filter(q=>!q.explanation).length}. Варианты сохранены в исходном порядке.`)
  return {bank,images,report:{sha256:await sha(bytes), sections:bank.sections.length,questions:bank.questions.length,answers,images:linked.size,warnings}}
}
