import { useEffect, useState } from 'react'

// The Dropbox popup lands here after consent. Its only job is to relay the
// authorization code (and state) back to the opener window via postMessage,
// then close itself. The opener completes the PKCE exchange. Rendered outside
// the app shell so the popup stays minimal.
function OAuthCallbackPage() {
  const [orphaned, setOrphaned] = useState(false)

  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const message = {
      type: 'tk-oauth',
      code: params.get('code'),
      state: params.get('state'),
      error: params.get('error_description') || params.get('error') || null,
    }

    if (window.opener && !window.opener.closed) {
      // Target the exact origin — never post the code to a wildcard.
      window.opener.postMessage(message, window.location.origin)
      window.close()
    } else {
      // Opened directly / opener gone: nothing to hand the code to.
      setOrphaned(true)
    }
  }, [])

  return (
    <div className="min-h-screen flex items-center justify-center bg-background text-on-background p-gutter">
      <div className="text-center">
        <span className="material-symbols-outlined animate-spin text-[40px] text-primary mb-3 block">
          progress_activity
        </span>
        <p className="font-body-md text-body-md text-on-surface-variant">
          {orphaned ? 'You can close this window.' : 'Finishing connection…'}
        </p>
      </div>
    </div>
  )
}

export default OAuthCallbackPage
