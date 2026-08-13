// Resume positions for the media player (0XC-462) — every rule, DOM-free, so
// PlayerContext stays the only place that touches a media element.
//
// This is a deliberate exception to "the frontend keeps its lists in memory,
// not localStorage": a resume point is per-browser by design (it never syncs
// across devices) and there is no server column for it. Do NOT sweep the
// `tubekeepResume:*` keys as leftovers the way HistoryContext sweeps the legacy
// `tubekeepHistory` / `tubekeepExpired` ones.

// One key per identity, so logging out and back in as someone else can't resume
// *their* copy of a video at *your* position. Logged-out /play/:id visitors
// share the `anon` namespace. The entry cap below applies per namespace.
const KEY_PREFIX = 'tubekeepResume:'
const ANON = 'anon'

// Don't record a barely-started video…
export const MIN_POSITION_SECONDS = 10
// …and don't record (or restore) one that's effectively finished: resuming at
// 59:58 of a 60:00 film ends playback instantly and forces the user to scrub
// back — the worst outcome this feature can produce. The tail guard prevents it
// even when `ended` never fires.
export const MIN_TAIL_SECONDS = 15
// Bounded storage: ~50 entries is roughly 2KB, so `setItem` can't start
// throwing on a full quota — which, being swallowed by the try/catch below,
// would mean resume silently stops working forever with no symptom.
export const MAX_ENTRIES = 50
// Throttle for the periodic write during playback.
export const SAVE_INTERVAL_MS = 5000

// Which identity a track's position is filed under. `sourceKey` when the record
// carries one, else `downloadId` — so a re-download (new `downloadId`, same
// canonical video) keeps your place. Same fallback rule as `sharesSource` in
// lib/media.js and `supersedeForUser` in the backend's downloadsStore.
export function resumeKey(track) {
  return track?.sourceKey || track?.downloadId || null
}

function storageKey(email) {
  return `${KEY_PREFIX}${email || ANON}`
}

// Every storage access is guarded: localStorage throws in private mode and on a
// full quota, and resume must never be able to break playback.
function readMap(email) {
  try {
    const raw = localStorage.getItem(storageKey(email))
    const parsed = raw ? JSON.parse(raw) : null
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

function writeMap(email, map) {
  try {
    localStorage.setItem(storageKey(email), JSON.stringify(map))
  } catch {
    // unavailable or full — resume is simply inert, playback is unaffected
  }
}

// Keep only the `max` most recently updated entries. The LRU is the *only*
// reaper: entries are never dropped when a download is deleted, expired or
// moved to cloud, because outliving the media is the point — expire a film,
// re-download it later, land back where you were.
export function pruneEntries(map, max = MAX_ENTRIES) {
  const entries = Object.entries(map).filter(
    ([, e]) => Number.isFinite(e?.t) && Number.isFinite(e?.u),
  )
  if (entries.length <= max) return Object.fromEntries(entries)
  entries.sort((a, b) => b[1].u - a[1].u)
  return Object.fromEntries(entries.slice(0, max))
}

// Is `time` worth remembering in a file of `duration` seconds? Used on the
// write side as the save predicate and on the read side as the clamp — one
// definition, so a position can never be stored that wouldn't be restored.
export function isResumable(time, duration) {
  if (!Number.isFinite(time) || !Number.isFinite(duration) || duration <= 0) return false
  return time > MIN_POSITION_SECONDS && duration - time >= MIN_TAIL_SECONDS
}

// The saved position for `key`, or null when there is nothing to restore.
// `duration` is this file's actual length: the same key can front two different
// files (a 4K copy expired, an audio-only one re-downloaded), so a position
// that isn't `MIN_TAIL_SECONDS` short of *this* file is ignored outright rather
// than clamped — starting at 0 beats starting at the end.
export function readPosition(email, key, duration) {
  if (!key) return null
  const entry = readMap(email)[key]
  const time = Number(entry?.t)
  return isResumable(time, duration) ? time : null
}

// Record where playback is. A position that fails the predicate is dropped on
// the floor (not deleted): `ended` is what forgets a finished video.
export function savePosition(email, key, time, duration) {
  if (!key || !isResumable(time, duration)) return
  const map = readMap(email)
  map[key] = { t: time, u: Date.now() }
  writeMap(email, pruneEntries(map))
}

export function clearPosition(email, key) {
  if (!key) return
  const map = readMap(email)
  if (!(key in map)) return
  delete map[key]
  writeMap(email, map)
}
