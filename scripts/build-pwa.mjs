import { createHash } from 'node:crypto'
import { readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
async function walk(dir){return (await Promise.all((await readdir(dir,{withFileTypes:true})).map(e=>e.isDirectory()?walk(join(dir,e.name)):[join(dir,e.name)]))).flat()}
const base=process.env.VITE_BASE_PATH??'/'
if(!/^\/(?:[a-zA-Z0-9_-]+\/)*$/.test(base))throw new Error('Invalid VITE_BASE_PATH')
const files=(await walk('dist')).filter(p=>p==='dist/index.html'||p.startsWith('dist/assets/')||/dist\/(?:icon[^/]*\.(?:png|svg)|manifest.webmanifest)$/.test(p)).sort()
const hash=createHash('sha256')
for(const file of files){hash.update(file);hash.update(await readFile(file))}
const version=hash.digest('hex').slice(0,20),urls=files.map(p=>base+p.slice(5))
const worker=`// Generated app-shell cache. Private questions/auth/API responses never enter Cache Storage.
const PREFIX=${JSON.stringify('1c-shell-'+Buffer.from(base).toString('hex')+'-')};
const CACHE=PREFIX+'${version}';
const BASE=${JSON.stringify(base)};
const URLS=${JSON.stringify(urls)};
self.addEventListener('install',event=>event.waitUntil((async()=>{
  const cache=await caches.open(CACHE);
  try{await cache.addAll(URLS.map(url=>new Request(url,{cache:'reload',credentials:'omit'})));}
  catch(error){await caches.delete(CACHE);throw error;}
})()));
self.addEventListener('activate',event=>event.waitUntil((async()=>{
  const names=(await caches.keys()).filter(name=>name.startsWith(PREFIX));
  const previous=names.filter(name=>name!==CACHE).at(-1);
  await Promise.all(names.filter(name=>name!==CACHE&&name!==previous).map(name=>caches.delete(name)));
  await self.clients.claim();
})()));
self.addEventListener('message',event=>{if(event.data==='ACTIVATE_UPDATE')self.skipWaiting();});
self.addEventListener('fetch',event=>{
  const request=event.request,url=new URL(request.url);
  if(request.method!=='GET'||url.origin!==self.location.origin)return;
  if(request.mode==='navigate'&&(url.pathname===BASE||url.pathname===BASE+'index.html')){
    event.respondWith(caches.open(CACHE).then(cache=>cache.match(BASE+'index.html')));return;
  }
  if(URLS.includes(url.pathname)&&url.pathname!==BASE+'index.html'){
    event.respondWith((async()=>{const cache=await caches.open(CACHE);return await cache.match(url.pathname)||fetch(request);})());
  }
});
`
await writeFile('dist/sw.js',worker)
console.log(JSON.stringify({pwa_version:version,precache_assets:urls.length,private_api_cached:false}))

await writeFile('dist/.nojekyll','')
