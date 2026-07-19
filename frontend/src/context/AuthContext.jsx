import { useCallback, useEffect, useMemo, useState } from 'react'
import { API_URL, AUTH_UNAUTHORIZED_EVENT } from '../lib/media'
import { AuthContext } from './authContext.js'

// The magic-link session is an httpOnly cookie the frontend never reads; auth
// state is derived purely from GET /api/auth/me. The auth endpoints are hit with
// plain credentialed fetch (not lib/media's apiFetch): a 401 from /me is the
// normal "not logged in" signal, not a session-expiry event, so it must not
// re-broadcast AUTH_UNAUTHORIZED_EVENT and loop back into this provider.
function authFetch(path, init) {
  return fetch(`${API_URL}${path}`, { credentials: 'include', ...init })
}

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null)
  const [loading, setLoading] = useState(true)

  // Resolve the current session user (or null). Reused on mount, after a
  // magic-link landing, and anywhere the app wants to re-check the session.
  const refresh = useCallback(async () => {
    try {
      const res = await authFetch('/api/auth/me')
      if (!res.ok) {
        setUser(null)
        return null
      }
      const data = await res.json()
      const nextUser = data.success ? data.data : null
      setUser(nextUser)
      return nextUser
    } catch {
      // Network error → treat as logged out; a protected call will re-surface it.
      setUser(null)
      return null
    }
  }, [])

  // Step 1 of login: ask the backend to email a magic link. The backend always
  // responds generically (never reveals whether the email is allowed), so a
  // resolved promise just means "request accepted" — the UI shows the same
  // "check your inbox" copy regardless. Throws on a transport/500 failure so the
  // login page can show a retry state.
  const login = useCallback(async (email) => {
    const res = await authFetch('/api/auth/request', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email }),
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok || !data.success) {
      throw new Error(data.error || 'Could not send the sign-in link. Try again.')
    }
    return data.data
  }, [])

  // Clear the session cookie server-side, then drop the local user regardless of
  // the network result (a failed logout still shouldn't strand a stale session
  // in the UI).
  const logout = useCallback(async () => {
    try {
      await authFetch('/api/auth/logout', { method: 'POST' })
    } catch {
      // ignore — clear locally anyway
    }
    setUser(null)
  }, [])

  // Load the session once on mount.
  useEffect(() => {
    let cancelled = false
    refresh().finally(() => {
      if (!cancelled) setLoading(false)
    })
    return () => {
      cancelled = true
    }
  }, [refresh])

  // A protected API call returned 401 (session expired mid-use): drop the user so
  // the route gate bounces to /login. Broadcast by lib/media's apiFetch.
  useEffect(() => {
    const onUnauthorized = () => setUser(null)
    window.addEventListener(AUTH_UNAUTHORIZED_EVENT, onUnauthorized)
    return () => window.removeEventListener(AUTH_UNAUTHORIZED_EVENT, onUnauthorized)
  }, [])

  const value = useMemo(
    () => ({ user, loading, login, logout, refresh }),
    [user, loading, login, logout, refresh],
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}
