import { existsSync } from 'node:fs'
import { defineConfig } from '@playwright/test'
export default defineConfig({
  testDir:'./tests/e2e',fullyParallel:false,workers:1,timeout:90_000,
  use:{headless:true,launchOptions:{executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ?? (existsSync('/usr/bin/chromium')?'/usr/bin/chromium':undefined),args:['--no-sandbox']},trace:'retain-on-failure'},
  projects:[
    {name:'local',testIgnore:['**/cloud.spec.ts','**/pwa.spec.ts'],use:{baseURL:'http://127.0.0.1:5173'}},
    {name:'cloud-client',testMatch:'**/cloud.spec.ts',use:{baseURL:'http://127.0.0.1:5174'}},
    {name:'pwa',testMatch:'**/pwa.spec.ts',use:{baseURL:'http://127.0.0.1:4175'}},
  ],
  webServer:[
    {env:{VITE_BASE_PATH:'/',VITE_LOCAL_ONLY:'true'},command:'npm run dev -- --port 5173',url:'http://127.0.0.1:5173',reuseExistingServer:!process.env.CI},
    {env:{VITE_BASE_PATH:'/',VITE_LOCAL_ONLY:'false',VITE_SUPABASE_URL:'https://test.supabase.co',VITE_SUPABASE_PUBLISHABLE_KEY:'sb_publishable_synthetic_test_only'},command:'npm run dev -- --port 5174 --strictPort',url:'http://127.0.0.1:5174',reuseExistingServer:false},
    {command:'npm run preview -- --port 4175 --strictPort',url:'http://127.0.0.1:4175'+(process.env.VITE_BASE_PATH??'/'),reuseExistingServer:false},
  ],
})
