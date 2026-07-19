import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { createBrowserRouter, RouterProvider } from 'react-router-dom'
import './index.css'
import App from './App.jsx'
import ProtectedRoute from './components/ProtectedRoute.jsx'
import { AuthProvider } from './context/AuthContext.jsx'
import { HistoryProvider } from './context/HistoryContext.jsx'
import { PlayerProvider } from './context/PlayerContext.jsx'
import DownloadPage from './pages/DownloadPage.jsx'
import DownloadsPage from './pages/DownloadsPage.jsx'
import HomePage from './pages/HomePage.jsx'
import InfoPage from './pages/InfoPage.jsx'
import LoginPage from './pages/LoginPage.jsx'
import NotFoundPage from './pages/NotFoundPage.jsx'
import OAuthCallbackPage from './pages/OAuthCallbackPage.jsx'
import PlayPage from './pages/PlayPage.jsx'

const router = createBrowserRouter([
  // Standalone (outside the app shell): the login page and the OAuth popup relay.
  { path: '/login', element: <LoginPage /> },
  { path: '/oauth/callback', element: <OAuthCallbackPage /> },
  {
    path: '/',
    element: <App />,
    children: [
      // Public share path — reachable without a session so shared links play for
      // logged-out recipients. Declared before the ProtectedRoute gate below.
      { path: 'play/:downloadId', element: <PlayPage /> },
      // Everything else is login-gated. ProtectedRoute redirects anonymous
      // visitors to /login and handles the magic-link verify redirect target.
      {
        element: <ProtectedRoute />,
        children: [
          { index: true, element: <HomePage /> },
          { path: 'downloads', element: <DownloadsPage /> },
          { path: 'info', element: <InfoPage /> },
          { path: 'download/:downloadId', element: <DownloadPage /> },
          { path: '*', element: <NotFoundPage /> },
        ],
      },
    ],
  },
])

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <AuthProvider>
      <HistoryProvider>
        <PlayerProvider>
          <RouterProvider router={router} />
        </PlayerProvider>
      </HistoryProvider>
    </AuthProvider>
  </StrictMode>,
)
