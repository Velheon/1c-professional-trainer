import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import CloudProvider from './cloud/CloudProvider'
import StorageBoundary from './components/StorageBoundary'
import LocalStorageGate from './components/LocalStorageGate'
import './styles.css'
createRoot(document.getElementById('root')!).render(<StrictMode><StorageBoundary><LocalStorageGate><CloudProvider><App/></CloudProvider></LocalStorageGate></StorageBoundary></StrictMode>)
