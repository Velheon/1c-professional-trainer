import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
const base=process.env.VITE_BASE_PATH??'/'
if(!/^\/(?:[a-zA-Z0-9_-]+\/)*$/.test(base))throw new Error('Invalid VITE_BASE_PATH')
export default defineConfig({
  base,
  plugins: [react(),{
    name:'production-csp',apply:'build',
    transformIndexHtml:()=>[{tag:'meta',attrs:{'http-equiv':'Content-Security-Policy',content:"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' blob: data:; connect-src 'self' https://*.supabase.co wss://*.supabase.co; object-src 'none'; base-uri 'self'; form-action 'self'; manifest-src 'self'; worker-src 'self' blob:"},injectTo:'head'}],
  }],
  cacheDir:process.env.VITE_LOCAL_ONLY==='true'?'node_modules/.vite-local':'node_modules/.vite-cloud',
  server: { fs: { deny: ['.env', '.env.*', '**/*.zip', '**/reports/**', '**/private/**', '**/platform_83/**'] } },
  test: { include: ['tests/**/*.test.ts'], setupFiles: ['tests/setup.ts'] },
})
