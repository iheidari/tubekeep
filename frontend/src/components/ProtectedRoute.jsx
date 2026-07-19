import { useEffect } from 'react'
import { Navigate, Outlet, useSearchParams } from 'react-router-dom'
import { useAuth } from '../context/useAuth'

// Login gate for every app route it wraps. The public share path (/play/:id) and
// the standalone /login and /oauth/callback routes are mounted OUTSIDE this
// wrapper, so shared links keep working for logged-out visitors.
//
// It also absorbs the magic-link landing: the backend's GET /api/auth/verify
// consumes the token and 302s to the app root with ?login=success|error. On
// success the session cookie is already set and AuthProvider has loaded the user,
// so we simply fall through into the app and strip the one-shot flag from the
// URL. On error (or any unauthenticated visit) we redirect to /login, carrying
// the error so the login page can explain the expired/invalid link.
function ProtectedRoute() {
  const { user, loading } = useAuth()
  const [params, setParams] = useSearchParams()
  const loginStatus = params.get('login')

  // Once authenticated, drop ?login=success from the URL so a reload/back-nav
  // doesn't keep it around. The error case redirects to /login (below), which
  // discards the query anyway, so only clean up when we're staying put.
  useEffect(() => {
    if (loginStatus && user) {
      const next = new URLSearchParams(params)
      next.delete('login')
      setParams(next, { replace: true })
    }
  }, [loginStatus, user, params, setParams])

  if (loading) {
    return (
      <div className="flex flex-col items-center justify-center py-stack-lg" role="status">
        <span
          className="material-symbols-outlined animate-spin text-[40px] text-muted"
          aria-hidden="true"
        >
          progress_activity
        </span>
        <span className="sr-only">Loading…</span>
      </div>
    )
  }

  if (!user) {
    return <Navigate to="/login" replace state={{ linkError: loginStatus === 'error' }} />
  }

  return <Outlet />
}

export default ProtectedRoute
