import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { unzipSync } from 'fflate'
async function files(dir){return (await Promise.all((await readdir(dir,{withFileTypes:true})).map(x=>x.isDirectory()?files(join(dir,x.name)):[join(dir,x.name)]))).flat()}
const output=await files('dist')
let ids=[]
try{
  const archive=unzipSync(await readFile('platform_83_export.zip'))
  const bank=JSON.parse(new TextDecoder().decode(archive['platform_83/questions.json']))
  ids=bank.questions.flatMap(q=>[q.question_id,...q.answers.map(a=>a.answer_id)])
}catch(error){if(error.code!=='ENOENT')throw error;console.log('Private archive absent: UUID scan skipped')}
const privateIds=new Set(ids)
const problems=[]
for(const path of output){
  const text=await readFile(path,'utf8')
  if(path.endsWith('.zip')||(text.match(/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/gi)??[]).some(id=>privateIds.has(id.toLowerCase())))problems.push({path,check:'private_bank'})
  if(/sb_secret_[A-Za-z0-9_-]{10,}/.test(text))problems.push({path,check:'secret_key'})
  if(text.includes('sb_publishable_synthetic_test_only'))problems.push({path,check:'synthetic_key_in_production'})
  for(const token of text.match(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g)??[]){
    try{if(JSON.parse(Buffer.from(token.split('.')[1],'base64url').toString()).role==='service_role')problems.push({path,check:'service_role_jwt'})}catch{/* Non-JWT source fragment */}
  }
}
console.log(JSON.stringify({build_files:output.length,private_ids_checked:ids.length,problems},null,2))
if(problems.length)process.exitCode=1
