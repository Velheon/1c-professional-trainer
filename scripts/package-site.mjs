import { readdir, readFile, writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { zipSync } from 'fflate'
async function walk(dir){return (await Promise.all((await readdir(dir,{withFileTypes:true})).map(e=>e.isDirectory()?walk(join(dir,e.name)):[join(dir,e.name)]))).flat()}
const files={}
for(const path of await walk('dist')){
  const relative=path.slice(5)
  if(!/^(?:\.nojekyll|index\.html|sw\.js|manifest\.webmanifest|icon[^/]*\.(?:png|svg)|_headers|_redirects|assets\/[^/]+\.(?:js|css))$/.test(relative))throw new Error('Unexpected deployment asset: '+relative)
  files[relative]=new Uint8Array(await readFile(path))
}
for(const required of ['index.html','sw.js','manifest.webmanifest','_headers'])if(!files[required])throw new Error('Build is incomplete')
const zip=zipSync(files)
await mkdir('private',{recursive:true})
await writeFile('private/trainer-site.zip',zip)
console.log(JSON.stringify({archive:'private/trainer-site.zip',files:Object.keys(files).length,bytes:zip.byteLength,contains_question_bank:false}))
