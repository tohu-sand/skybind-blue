import React from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import App from './App'
import AppErrorBoundary from './components/AppErrorBoundary'
// Fonts are self-hosted (bundled from @fontsource) so no third-party font CDN
// sees visitor traffic; licenses are listed in public/THIRD_PARTY_NOTICES.txt.
import '@fontsource/zen-kaku-gothic-antique/400.css'
import '@fontsource/zen-kaku-gothic-antique/700.css'
import '@fontsource/ibm-plex-sans/400.css'
import '@fontsource/ibm-plex-sans/600.css'
import './index.css'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <AppErrorBoundary>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </AppErrorBoundary>
  </React.StrictMode>,
)
