import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import CloudProvider from './cloud/CloudProvider'
import StorageBoundary from './components/StorageBoundary'
import './styles.css'
createRoot(document.getElementById('root')!).render(<StrictMode><StorageBoundary><CloudProvider><App/></CloudProvider></StorageBoundary></StrictMode>)
