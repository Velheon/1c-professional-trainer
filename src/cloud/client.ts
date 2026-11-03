import { createClient } from '@supabase/supabase-js'
import Dexie, { type EntityTable } from 'dexie'
const url=import.meta.env.VITE_SUPABASE_URL?.trim()??''
const key=import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY?.trim()??''
// Test/localhost-only opt-out cannot enable public local-bank hosting.
export const localHost=['localhost','127.0.0.1','[::1]'].includes(location.hostname)
export const configurationError=(!url&&!key)?'':(!/^https:\/\/[a-z0-9-]+\.supabase\.co$/.test(url)||!key.startsWith('sb_publishable_'))?'Проверьте URL проекта и publishable key в .env.local':''
class AuthDB extends Dexie {
  tokens!:EntityTable<{key:string;value:string},'key'>
  constructor(){super('1c-trainer-auth');this.version(1).stores({tokens:'key'})}
}
const authDB=new AuthDB()
const enabled=!!url&&!!key&&!configurationError&&!(localHost&&import.meta.env.VITE_LOCAL_ONLY==='true')
export const projectUrl=url
export const supabase=enabled?createClient(url,key,{auth:{persistSession:true,autoRefreshToken:true,detectSessionInUrl:false,storage:{
  getItem:async k=>(await authDB.tokens.get(k))?.value??null,
  setItem:async(k,v)=>{await authDB.tokens.put({key:k,value:v})},
  removeItem:async k=>{await authDB.tokens.delete(k)},
}}}):null
export async function clearLocalAuth(){await authDB.tokens.clear()}
