import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { createBrowserRouter, RouterProvider } from 'react-router-dom'
import './index.css'
import App from './App.jsx'
import { HistoryProvider } from './context/HistoryContext.jsx'
import { PlayerProvider } from './context/PlayerContext.jsx'
import DownloadPage from './pages/DownloadPage.jsx'
import DownloadsPage from './pages/DownloadsPage.jsx'
import HomePage from './pages/HomePage.jsx'
import InfoPage from './pages/InfoPage.jsx'
import NotFoundPage from './pages/NotFoundPage.jsx'
import OAuthCallbackPage from './pages/OAuthCallbackPage.jsx'
import PlayPage from './pages/PlayPage.jsx'

const router = createBrowserRouter([
  // Standalone (outside the app shell) so the OAuth popup stays minimal.
  { path: '/oauth/callback', element: <OAuthCallbackPage /> },
  {
    path: '/',
    element: <App />,
    children: [
      { index: true, element: <HomePage /> },
      { path: 'downloads', element: <DownloadsPage /> },
      { path: 'info', element: <InfoPage /> },
      { path: 'download/:downloadId', element: <DownloadPage /> },
      { path: 'play/:downloadId', element: <PlayPage /> },
      { path: '*', element: <NotFoundPage /> },
    ],
  },
])

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <HistoryProvider>
      <PlayerProvider>
        <RouterProvider router={router} />
      </PlayerProvider>
    </HistoryProvider>
  </StrictMode>,
)
