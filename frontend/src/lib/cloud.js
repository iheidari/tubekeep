// Generic "Move to cloud" client: PKCE connect flow + per-provider token store,
// data-driven by the PROVIDERS table below. One module serves every provider
// (Dropbox, Google Drive, …) so the PKCE/token logic lives in exactly one place.
//
// Security model (see docs/cloud-upload-design.md):
//   - PKCE public-client flow from a popup; the app secret never touches the
//     browser — the backend relay does the code/refresh exchange.
//   - Tokens live ONLY in sessionStorage (die with the tab); nothing persists
//     server-side. The access token is sent to /api/cloud/upload in the body,
//     never in a URL.

import { API_URL } from './media'

// Per-provider static metadata. The OAuth client id + redirect URI are resolved
// at runtime from the backend's /api/cloud/providers (or a VITE_ override). The
// `configKey` is the field the backend publishes the client id under.
const PROVIDERS = {
  dropbox: {
    label: 'Dropbox',
    icon: 'cloud',
    authEndpoint: 'https://www.dropbox.com/oauth2/authorize',
    scopes: 'files.content.write account_info.read',
    // `offline` so we receive a refresh token for the ~4h access token.
    authParams: { token_access_type: 'offline' },
    configKey: 'appKey',
    viteClientId: 'VITE_DROPBOX_APP_KEY',
    viteRedirect: 'VITE_DROPBOX_REDIRECT_URI',
  },
  googledrive: {
    label: 'Google Drive',
    icon: 'add_to_drive',
    authEndpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
    scopes: 'https://www.googleapis.com/auth/drive.file',
    // Google only returns a refresh token with access_type=offline, and only
    // re-issues one when the user is re-prompted for consent.
    authParams: { access_type: 'offline', prompt: 'consent', include_granted_scopes: 'true' },
    configKey: 'clientId',
    viteClientId: 'VITE_GOOGLE_CLIENT_ID',
    viteRedirect: 'VITE_GOOGLE_REDIRECT_URI',
  },
}

// Refresh a little before an access token actually expires.
const REFRESH_SKEW_MS = 2 * 60 * 1000

// --- base64url + PKCE helpers ---------------------------------------------

function base64url(bytes) {
  let str = ''
  for (const b of bytes) str += String.fromCharCode(b)
  return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function randomString(byteLen = 48) {
  const bytes = new Uint8Array(byteLen)
  crypto.getRandomValues(bytes)
  return base64url(bytes)
}

async function sha256Challenge(verifier) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))
  return base64url(new Uint8Array(digest))
}

// --- enabled providers (authoritative from the backend) -------------------

let providersPromise = null

// Resolve the runtime config { clientId, redirectUri } for one provider from a
// backend /providers entry (or a VITE_ override), or null if not configured.
function resolveConfig(name, serverEntry) {
  const meta = PROVIDERS[name]
  if (!meta) return null
  const clientId = import.meta.env[meta.viteClientId] || serverEntry?.[meta.configKey]
  if (!clientId) return null
  return {
    name,
    label: meta.label,
    icon: meta.icon,
    clientId,
    redirectUri: import.meta.env[meta.viteRedirect] || serverEntry?.redirectUri,
  }
}

// Fetch the list of enabled, known providers with their resolved config. Cached
// for the tab on success. Returns [{ name, label, icon, clientId, redirectUri }].
export function getEnabledProviders() {
  if (!providersPromise) {
    providersPromise = fetch(`${API_URL}/api/cloud/providers`)
      .then((r) => r.json())
      .then((body) => {
        const server = body?.data || []
        const byName = new Map(server.map((p) => [p.name, p]))
        return Object.keys(PROVIDERS)
          .map((name) => resolveConfig(name, byName.get(name)))
          .filter(Boolean)
      })
      .catch(() => {
        // Don't cache a transient failure — that would hide "Move to cloud" for
        // the whole tab until reload. Clear it so the next call retries.
        providersPromise = null
        return []
      })
  }
  return providersPromise
}

async function getProviderConfig(name) {
  const list = await getEnabledProviders()
  return list.find((p) => p.name === name) || null
}

// --- token store (sessionStorage, keyed per provider) ---------------------

const tokenKey = (name) => `tk_cloud_${name}`

function loadToken(name) {
  try {
    const raw = sessionStorage.getItem(tokenKey(name))
    return raw ? JSON.parse(raw) : null
  } catch {
    return null
  }
}

function saveToken(name, token) {
  try {
    sessionStorage.setItem(tokenKey(name), JSON.stringify(token))
  } catch {
    // ignore unavailable sessionStorage
  }
}

export function disconnect(name) {
  try {
    sessionStorage.removeItem(tokenKey(name))
  } catch {
    // ignore
  }
}

// --- connect (popup) ------------------------------------------------------

// Open a provider's consent popup and complete the PKCE exchange via the backend
// relay. Resolves with the connected account; rejects if cancelled/blocked.
// MUST be called from a user gesture so the popup isn't blocked.
export async function connect(name) {
  const meta = PROVIDERS[name]
  const config = await getProviderConfig(name)
  if (!meta || !config) throw new Error(`${meta?.label || name} is not configured on this server`)

  const verifier = randomString()
  const state = randomString(16)
  const challenge = await sha256Challenge(verifier)

  const params = new URLSearchParams({
    client_id: config.clientId,
    response_type: 'code',
    redirect_uri: config.redirectUri,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    scope: meta.scopes,
    state,
    ...meta.authParams,
  })

  const popup = window.open(
    `${meta.authEndpoint}?${params.toString()}`,
    'tk_cloud_oauth',
    'width=600,height=720',
  )
  if (!popup) throw new Error('Popup blocked — allow popups and try again')

  const code = await new Promise((resolve, reject) => {
    let settled = false
    const cleanup = () => {
      settled = true
      window.removeEventListener('message', onMessage)
      clearInterval(closedTimer)
      clearTimeout(timeout)
    }
    const onMessage = (event) => {
      if (event.origin !== window.location.origin) return
      const data = event.data
      if (data?.type !== 'tk-oauth') return
      if (data.state !== state) return // CSRF guard
      cleanup()
      try {
        popup.close()
      } catch {
        // ignore
      }
      if (data.error) reject(new Error(data.error))
      else resolve(data.code)
    }
    window.addEventListener('message', onMessage)
    const closedTimer = setInterval(() => {
      if (popup.closed && !settled) {
        cleanup()
        reject(new Error('Connection cancelled'))
      }
    }, 500)
    const timeout = setTimeout(
      () => {
        if (settled) return
        cleanup()
        reject(new Error('Connection timed out'))
      },
      3 * 60 * 1000,
    )
  })

  const res = await fetch(`${API_URL}/api/cloud/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      provider: name,
      code,
      codeVerifier: verifier,
      redirectUri: config.redirectUri,
    }),
  })
  const body = await res.json()
  if (!body.success) throw new Error(body.error || `Failed to connect ${meta.label}`)

  const { accessToken, refreshToken, expiresIn, account } = body.data
  saveToken(name, {
    accessToken,
    refreshToken,
    account,
    expiresAt: expiresIn ? Date.now() + expiresIn * 1000 : 0,
  })
  return { account }
}

// --- access token (refresh-aware) ----------------------------------------

// Return a valid access token for a provider, refreshing via the relay if it's
// near expiry. Throws 'NOT_CONNECTED' if there's no stored token so callers can
// prompt connect.
export async function getFreshAccessToken(name) {
  const meta = PROVIDERS[name]
  const token = loadToken(name)
  if (!token) {
    const err = new Error(`Not connected to ${meta?.label || name}`)
    err.code = 'NOT_CONNECTED'
    throw err
  }

  const fresh = token.expiresAt && Date.now() < token.expiresAt - REFRESH_SKEW_MS
  if (fresh || !token.refreshToken) return token.accessToken

  const res = await fetch(`${API_URL}/api/cloud/oauth/refresh`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ provider: name, refreshToken: token.refreshToken }),
  })
  const body = await res.json()
  if (!body.success) {
    // Refresh failed (revoked/expired) — force a reconnect next time.
    disconnect(name)
    const err = new Error(`${meta?.label || name} session expired — please reconnect`)
    err.code = 'NOT_CONNECTED'
    throw err
  }

  const updated = {
    ...token,
    accessToken: body.data.accessToken,
    expiresAt: body.data.expiresIn ? Date.now() + body.data.expiresIn * 1000 : 0,
  }
  saveToken(name, updated)
  return updated.accessToken
}

// Human-readable label for a provider name (for "Open in <provider>" etc.).
export function providerLabel(name) {
  return PROVIDERS[name]?.label || 'cloud'
}
