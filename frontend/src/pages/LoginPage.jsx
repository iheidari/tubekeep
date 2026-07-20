import { useState } from 'react'
import { Link, Navigate, useLocation } from 'react-router-dom'
import Logo from '../components/Logo'
import { useAuth } from '../context/useAuth'

// Loose client-side sanity check only; the backend is the real allowlist. Just
// enough to catch an empty/obviously-malformed address before we call the API.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

function LoginPage() {
  const { user, loading, login } = useAuth()
  const location = useLocation()
  // Set by ProtectedRoute when the backend's /verify redirected here with
  // ?login=error (link invalid/expired/already used).
  const linkError = location.state?.linkError || false

  const [email, setEmail] = useState('')
  // idle → submitting → sent (generic confirmation) | error (request failed)
  const [status, setStatus] = useState('idle')
  const [fieldError, setFieldError] = useState('')

  // Wait for /api/auth/me before deciding what to render, so an already-signed-in
  // visitor doesn't see the sign-in form flash before the redirect.
  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-bg" role="status">
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

  // Already signed in? Nothing to do here — send them into the app.
  if (user) return <Navigate to="/" replace />

  const handleSubmit = async (e) => {
    e.preventDefault()
    const trimmed = email.trim()
    if (!EMAIL_RE.test(trimmed)) {
      setFieldError('Enter a valid email address.')
      return
    }
    setFieldError('')
    setStatus('submitting')
    try {
      await login(trimmed)
      setStatus('sent')
    } catch {
      setStatus('error')
    }
  }

  const sent = status === 'sent'

  return (
    <div className="min-h-screen flex flex-col items-center justify-center bg-bg text-ink px-gutter py-stack-lg">
      <div className="w-full max-w-[420px] text-center">
        <Link to="/" className="inline-block no-underline mb-stack-lg" aria-label="Tubekeep home">
          <Logo />
        </Link>

        {sent ? (
          <div role="status" className="bg-surface border border-line rounded-xl p-8">
            <span
              className="material-symbols-outlined text-[40px] text-ink mb-3 block"
              aria-hidden="true"
            >
              mark_email_read
            </span>
            <h1 className="font-headline-md text-headline-md text-ink mb-2">Check your inbox</h1>
            <p className="font-body-md text-body-md text-muted">
              If that email is registered, we've sent you a sign-in link. Click it to finish logging
              in.
            </p>
            <button
              type="button"
              onClick={() => setStatus('idle')}
              className="mt-6 font-label-md text-label-md text-muted hover:text-ink transition-colors"
            >
              Use a different email
            </button>
          </div>
        ) : (
          <>
            <h1 className="font-headline-md text-headline-md text-ink mb-2">Sign in to Tubekeep</h1>
            <p className="font-body-md text-body-md text-muted mb-stack-lg">
              Enter your email and we'll send you a sign-in link. No password required.
            </p>

            {linkError && (
              <div
                role="alert"
                className="mb-stack-md flex items-start gap-2 bg-tint border border-line2 rounded-lg px-4 py-3 text-left"
              >
                <span className="material-symbols-outlined text-[20px] text-pop" aria-hidden="true">
                  error
                </span>
                <p className="font-body-md text-[14px] text-ink">
                  That sign-in link was invalid or has expired. Enter your email to get a new one.
                </p>
              </div>
            )}

            <form onSubmit={handleSubmit} noValidate className="text-left">
              <label
                htmlFor="login-email"
                className="block font-label-md text-label-sm text-muted mb-1.5"
              >
                Email address
              </label>
              <div className="flex items-center gap-1 bg-surface border border-line2 rounded-xl pl-4 pr-2 py-1.5 shadow-sm focus-within:border-ink transition-colors">
                <span
                  className="material-symbols-outlined text-[22px] text-faint"
                  aria-hidden="true"
                >
                  mail
                </span>
                <input
                  id="login-email"
                  type="email"
                  autoComplete="email"
                  placeholder="you@example.com"
                  value={email}
                  onChange={(e) => {
                    setEmail(e.target.value)
                    if (fieldError) setFieldError('')
                    // Clear a prior send-failure banner once they start retyping.
                    if (status === 'error') setStatus('idle')
                  }}
                  disabled={status === 'submitting'}
                  aria-invalid={fieldError ? 'true' : undefined}
                  aria-describedby={fieldError ? 'login-email-error' : undefined}
                  className="flex-1 min-w-0 bg-transparent border-none focus:ring-0 font-body-md text-[16px] placeholder:text-faint text-ink px-2 py-2.5 outline-none"
                />
              </div>

              {fieldError && (
                <p
                  id="login-email-error"
                  role="alert"
                  className="mt-1.5 font-body-md text-[13px] text-pop"
                >
                  {fieldError}
                </p>
              )}

              {status === 'error' && (
                <p role="alert" className="mt-1.5 font-body-md text-[13px] text-pop">
                  Something went wrong sending your link. Please try again.
                </p>
              )}

              <button
                type="submit"
                disabled={status === 'submitting'}
                className="mt-stack-md w-full flex items-center justify-center gap-2 bg-fill text-on-fill font-label-md text-[15px] px-6 py-3.5 rounded-lg hover:opacity-90 active:scale-[0.99] transition-all disabled:opacity-50 disabled:cursor-not-allowed disabled:active:scale-100"
              >
                {status === 'submitting' ? (
                  <>
                    <span
                      className="material-symbols-outlined animate-spin text-[20px]"
                      aria-hidden="true"
                    >
                      progress_activity
                    </span>
                    Sending…
                  </>
                ) : (
                  'Send sign-in link'
                )}
              </button>
            </form>
          </>
        )}
      </div>
    </div>
  )
}

export default LoginPage
