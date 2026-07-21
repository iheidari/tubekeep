// Shared media helpers used across pages/components.

// Single source of truth for the API origin: explicit env, else same-origin
// (works in single-server mode). Lives here (not in React context) so any lib
// module can import it; the history context re-exports it as HISTORY_API_URL.
export const API_URL =
  import.meta.env.VITE_API_URL || (typeof window !== 'undefined' ? window.location.origin : '')

// Window event the API layer broadcasts when a protected call returns 401 (the
// magic-link session is missing/expired). The AuthProvider listens for it to
// drop the current user so the route gate bounces to /login. Kept as a plain
// string here (no React import) so both this lib and the context can share it.
export const AUTH_UNAUTHORIZED_EVENT = 'tk:unauthorized'

// Credentialed fetch for our own API. The session is an httpOnly cookie, so
// every call must send credentials — this is the single place that guarantees
// it. On a 401 it broadcasts AUTH_UNAUTHORIZED_EVENT (session expired) and still
// returns the response so callers keep their existing error handling. Lives in
// lib (not React) so any module — context, hooks, pages — can route through it.
export function apiFetch(input, init = {}) {
  return fetch(input, { credentials: 'include', ...init }).then((res) => {
    if (res.status === 401 && typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent(AUTH_UNAUTHORIZED_EVENT))
    }
    return res
  })
}

// How long a file lives on our server before it's expired (mirrors the backend
// MAX_FILE_AGE_HOURS in services/cleanup.js). Exposed so the UI can gate
// time-sensitive actions — e.g. don't start a cloud move that would race the
// expiry cleanup.
export const FILE_EXPIRY_MS = 60 * 60 * 1000

// Human-readable form of FILE_EXPIRY_MS for UI copy, so the messaging can't
// drift from the actual expiry window (e.g. '1 hour', '24 hours').
export function fileExpiryLabel() {
  const hours = Math.round(FILE_EXPIRY_MS / (60 * 60 * 1000))
  return hours === 1 ? '1 hour' : `${hours} hours`
}

const AUDIO_RE = /\.(mp3|m4a|ogg|opus|wav|flac)$/i

export function isAudioFile(filename) {
  return AUDIO_RE.test(filename || '')
}

// Canonical audio/video classification for a download record. Prefers the
// explicit `type` yt-dlp gave us, falling back to the filename extension. Use
// this everywhere so a download can't be labelled differently per screen.
export function mediaKind(download) {
  if (download?.type === 'audio') return 'audio'
  if (download?.type === 'video' || download?.type === 'combined') return 'video'
  return isAudioFile(download?.filename) ? 'audio' : 'video'
}

// mm:ss formatter shared by the format list and the player dock.
export function formatDuration(seconds, fallback = '') {
  if (!Number.isFinite(seconds) || seconds < 0) return fallback
  const mins = Math.floor(seconds / 60)
  const secs = Math.floor(seconds % 60)
  return `${mins}:${secs.toString().padStart(2, '0')}`
}

// Single place that talks to GET /api/files. Returns the raw download array
// (or [] on any failure), so callers don't each re-implement the fetch/guard.
export async function fetchDownloads(apiUrl) {
  const res = await apiFetch(`${apiUrl}/api/files`)
  const data = await res.json()
  if (!data.success || !Array.isArray(data.data)) return []
  return data.data
}

// Unwrap the `{ success, data }` envelope for the read-only endpoints whose
// callers degrade gracefully: null on a network error, a non-JSON body, or an
// unsuccessful response. Written once so the envelope shape lives in one place.
// `fetcher` defaults to the credentialed apiFetch; public endpoints pass plain
// `fetch` so a 401 can't be broadcast as a session expiry.
async function fetchData(url, fetcher = apiFetch) {
  try {
    const res = await fetcher(url)
    const data = await res.json()
    if (!data.success || !data.data) return null
    return data.data
  } catch {
    return null
  }
}

// Public per-item metadata for a download, keyed only by its id — resolves a
// /play/:id share link for someone who isn't the owner (or isn't logged in).
// No credentials needed; the endpoint is public. Returns null on any failure
// (unknown id, network error) so the caller falls back to a "missing" state.
export function fetchDownloadMeta(apiUrl, downloadId) {
  // Bare `fetch`, wrapped so it keeps its global `this` binding.
  return fetchData(`${apiUrl}/api/files/meta/${downloadId}`, (url) => fetch(url))
}

// Storage state for the format-screen banner + fit checks. Returns null on any
// failure so the UI degrades to "no banner, nothing blocked" rather than
// breaking the format list. Shape: { total, free, used, sizeMultiplier,
// headroomBytes, quota: { used, max, remaining } } — the server's disk plus this
// user's allowance, with the fit knobs the backend owns.
export function fetchDisk(apiUrl) {
  return fetchData(`${apiUrl}/api/disk`)
}

// Whether a download of `filesize` bytes fits within the server's disk margin.
// The multiplier/headroom come from the /api/disk response (backend-owned) so
// this can't drift from the backend hard-block. Unknown size, or no disk info
// yet, is never blocked — mirrors the backend's hasRoomFor.
export function hasRoomFor(filesize, disk) {
  if (!filesize || filesize <= 0) return true
  if (!disk) return true
  return disk.free >= filesize * disk.sizeMultiplier + disk.headroomBytes
}

// A quota `max`/`remaining` of -1 means "no cap" (the `users.max_storage_bytes`
// sentinel; see the backend's UNLIMITED_QUOTA).
export function isUnlimitedQuota(max) {
  return !Number.isFinite(Number(max)) || Number(max) < 0
}

// Whether a download of `filesize` bytes fits in the user's remaining storage
// quota. No multiplier or headroom — the quota counts what a download keeps, not
// its transient merge footprint. This consumes `quota.remaining` rather than
// re-deriving it from used/max: the backend's remainingQuota() already encodes
// both the subtraction and the clamp-at-zero, so there is one definition of "how
// much is left" and the two sides can't drift. Unknown size, unlimited quota, or
// no quota info yet is never blocked.
export function hasQuotaFor(filesize, disk) {
  if (!filesize || filesize <= 0) return true
  if (!disk?.quota) return true
  // Covers both the -1 sentinel and a missing/garbled value (fail open).
  if (isUnlimitedQuota(disk.quota.remaining)) return true
  return filesize <= Number(disk.quota.remaining)
}

// The single "can this format be downloaded?" answer, combining both guards the
// backend enforces at POST /api/download. Returns null when it fits, or a short
// reason to show under the disabled option.
export function downloadBlockReason(filesize, disk) {
  if (!hasQuotaFor(filesize, disk)) return 'Over your storage quota'
  if (!hasRoomFor(filesize, disk)) return 'Not enough space'
  return null
}

export function formatFileSize(bytes) {
  if (!bytes) return 'Unknown'
  // Clamp the unit index: the disk banner feeds whole-disk (multi-TB) sizes, so
  // TB/PB must exist and a value past the table can't fall off the end.
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB', 'PB']
  const i = Math.min(sizes.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)))
  return `${(bytes / 1024 ** i).toFixed(2)} ${sizes[i]}`
}

// Canonical file URL for a download. Pass { download: true } for a forced attachment.
export function fileUrl(apiUrl, downloadId, filename, { download = false } = {}) {
  const base = `${apiUrl}/api/files/${downloadId}/${encodeURIComponent(filename)}`
  return download ? `${base}?action=download` : base
}

// Per-tab persistence of download start params: written when a download starts
// (InfoPage) and read back if /download/:id is reloaded (DownloadPage) so the SSE
// resumes and the "Keep forever" choice survives. One key format lives here so the
// writer and reader can't drift.
const startKey = (downloadId) => `tk_start_${downloadId}`

export function saveStartParams(downloadId, params) {
  try {
    sessionStorage.setItem(startKey(downloadId), JSON.stringify(params))
  } catch {
    // ignore unavailable sessionStorage
  }
}

export function loadStartParams(downloadId) {
  try {
    const saved = sessionStorage.getItem(startKey(downloadId))
    if (saved) return JSON.parse(saved)
  } catch {
    // ignore malformed/unavailable sessionStorage
  }
  return null
}

export function clearStartParams(downloadId) {
  try {
    sessionStorage.removeItem(startKey(downloadId))
  } catch {
    // ignore
  }
}
