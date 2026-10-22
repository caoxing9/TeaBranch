import { StrictMode } from 'react'
import { setLocale } from '@shared/i18n'
import { api } from './lib/api'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import './styles.css'

// The language comes from main (the setting, or macOS's), before anything renders.
const root = document.getElementById('root')
if (root) {
  setLocale(await api.locale().catch(() => 'zh' as const))
  createRoot(root).render(
    <StrictMode>
      <App />
    </StrictMode>,
  )
}
