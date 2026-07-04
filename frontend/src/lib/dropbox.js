// Dropbox "Move to cloud" client: PKCE connect flow + per-session token store.
//
// Security model (see docs/cloud-upload-design.md):
//   - PKCE public-client flow from a popup; the app secret never touches the
//     browser — the backend relay does the code/refresh exchange.
//   - Tokens live ONLY in sessionStorage (die with the tab); nothing persists
//     server-side. The access token is sent to /api/cloud/upload in the body,
//     never in a URL.

import { API_URL } from './media'

const PROVIDER = 'dropbox'
const TOKEN_KEY = 'tk_cloud_dropbox'
const AUTH_ENDPOINT = 'https://www.dropbox.com/oauth2/authorize'
const SCOPES = 'files.content.write account_info.read'
// Refresh a little before the ~4h access token actually expires.
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

// --- provider config (authoritative from the backend) ---------------------

let configPromise = null

// Resolve { appKey, redirectUri } for Dropbox, or null if the server hasn't
// configured it. VITE_ env vars override the backend values if present.
export function getDropboxConfig() {
  if (!configPromise) {
    configPromise = fetch(`${API_URL}/api/cloud/providers`)
      .then((r) => r.json())
      .then((body) => {
        const server = (body?.data || []).find((p) => p.name === PROVIDER) || null
        if (!server && !import.meta.env.VITE_DROPBOX_APP_KEY) return null
        return {
          appKey: import.meta.env.VITE_DROPBOX_APP_KEY || server?.appKey,
          redirectUri: import.meta.env.VITE_DROPBOX_REDIRECT_URI || server?.redirectUri,
        }
      })
      .catch(() => null)
  }
  return configPromise
}

// --- token store (sessionStorage) -----------------------------------------

function loadToken() {
  try {
    const raw = sessionStorage.getItem(TOKEN_KEY)
    return raw ? JSON.parse(raw) : null
  } catch {
    return null
  }
}

function saveToken(token) {
  try {
    sessionStorage.setItem(TOKEN_KEY, JSON.stringify(token))
  } catch {
    // ignore unavailable sessionStorage
  }
}

export function disconnect() {
  try {
    sessionStorage.removeItem(TOKEN_KEY)
  } catch {
    // ignore
  }
}

// --- connect (popup) ------------------------------------------------------

// Open the Dropbox consent popup and complete the PKCE exchange via the backend
// relay. Resolves with the connected account; rejects if cancelled/blocked.
// MUST be called from a user gesture so the popup isn't blocked.
export async function connect() {
  const config = await getDropboxConfig()
  if (!config?.appKey) throw new Error('Dropbox is not configured on this server')

  const verifier = randomString()
  const state = randomString(16)
  const challenge = await sha256Challenge(verifier)

  const params = new URLSearchParams({
    client_id: config.appKey,
    response_type: 'code',
    redirect_uri: config.redirectUri,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    token_access_type: 'offline',
    scope: SCOPES,
    state,
  })

  const popup = window.open(
    `${AUTH_ENDPOINT}?${params.toString()}`,
    'tk_dropbox_oauth',
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
      provider: PROVIDER,
      code,
      codeVerifier: verifier,
      redirectUri: config.redirectUri,
    }),
  })
  const body = await res.json()
  if (!body.success) throw new Error(body.error || 'Failed to connect Dropbox')

  const { accessToken, refreshToken, expiresIn, account } = body.data
  saveToken({
    accessToken,
    refreshToken,
    account,
    expiresAt: expiresIn ? Date.now() + expiresIn * 1000 : 0,
  })
  return { account }
}

// --- access token (refresh-aware) ----------------------------------------

// Return a valid access token, refreshing via the relay if it's near expiry.
// Throws 'NOT_CONNECTED' if there's no stored token so callers can prompt connect.
export async function getFreshAccessToken() {
  const token = loadToken()
  if (!token) {
    const err = new Error('Not connected to Dropbox')
    err.code = 'NOT_CONNECTED'
    throw err
  }

  const fresh = token.expiresAt && Date.now() < token.expiresAt - REFRESH_SKEW_MS
  if (fresh || !token.refreshToken) return token.accessToken

  const res = await fetch(`${API_URL}/api/cloud/oauth/refresh`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ provider: PROVIDER, refreshToken: token.refreshToken }),
  })
  const body = await res.json()
  if (!body.success) {
    // Refresh failed (revoked/expired) — force a reconnect next time.
    disconnect()
    const err = new Error('Dropbox session expired — please reconnect')
    err.code = 'NOT_CONNECTED'
    throw err
  }

  const updated = {
    ...token,
    accessToken: body.data.accessToken,
    expiresAt: body.data.expiresIn ? Date.now() + body.data.expiresIn * 1000 : 0,
  }
  saveToken(updated)
  return updated.accessToken
}
