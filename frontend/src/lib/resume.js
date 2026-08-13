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

// Don't record a barely-started video — and, read the other way, this is the
// window in which restoring a position is a welcome nudge rather than a jolt.
const MIN_POSITION_SECONDS = 10
// Don't record (or restore) one that's effectively finished: resuming at 59:58
// of a 60:00 film ends playback instantly and forces the user to scrub back —
// the worst outcome this feature can produce. The tail guard prevents it even
// when `ended` never fires.
const MIN_TAIL_SECONDS = 15
// Bounded storage: ~50 entries is roughly 2KB, so `setItem` can't start
// throwing on a full quota — which, being swallowed by the try/catch below,
// would mean resume silently stops working forever with no symptom.
const MAX_ENTRIES = 50
// How often playback persists its position while it's running.
export const SAVE_INTERVAL_MS = 5000

// Which key a track's position is filed under: `sourceKey` when the record
// carries one, so a re-download (new `downloadId`, same canonical video) keeps
// your place. The fallback differs from `sharesSource`'s (lib/media.js) exact
// `url` on purpose — a track carries no url — and `downloadId` is also what an
// anonymous /play/:id viewer gets, the public meta endpoint carrying no
// `sourceKey`.
function resumeKey(track) {
  return track?.sourceKey || track?.downloadId || null
}

function storageKey(email) {
  return `${KEY_PREFIX}${email || ANON}`
}

// Every storage access is guarded: localStorage throws in private mode and on a
// full quota, and resume must never be able to break playback.
//
// Re-reading before every write is deliberate, not redundant I/O — it merges
// with whatever another tab has written since, which a cached map would clobber.
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

// Keep the `MAX_ENTRIES` most recently updated entries, dropping malformed ones
// on the way through. The LRU is the *only* reaper: entries are never dropped
// when a download is deleted, expired or moved to cloud, because outliving the
// media is the point — expire a film, re-download it later, land back where you
// were.
function pruneEntries(map) {
  return Object.fromEntries(
    Object.entries(map)
      .filter(([, e]) => Number.isFinite(e?.t) && Number.isFinite(e?.u))
      .sort((a, b) => b[1].u - a[1].u)
      .slice(0, MAX_ENTRIES),
  )
}

// Is `time` worth remembering in a file of `duration` seconds? The save
// predicate and the read-side test are this one definition, so a position can
// never be stored that wouldn't be restored.
function isResumable(time, duration) {
  if (!Number.isFinite(time) || !Number.isFinite(duration) || duration <= 0) return false
  return time > MIN_POSITION_SECONDS && duration - time >= MIN_TAIL_SECONDS
}

// Where playback of `track` should pick up, or null for "leave it alone" — the
// whole read-side decision, so the player only has to choose *when* to ask.
// `duration` is this file's actual length: the same key can front two different
// files (a 4K copy expired, an audio-only one re-downloaded), so a position that
// isn't `MIN_TAIL_SECONDS` short of *this* file is rejected outright rather than
// clamped — starting at 0 beats starting at the end. `currentTime` makes a late
// answer harmless: once the viewer is genuinely watching, nothing moves them.
export function positionToSeek(email, track, { duration, currentTime }) {
  const key = resumeKey(track)
  // Negated rather than `>=` so an unknown (NaN) currentTime declines to seek.
  if (!key || !(currentTime < MIN_POSITION_SECONDS)) return null
  const time = Number(readMap(email)[key]?.t)
  return isResumable(time, duration) ? time : null
}

// Record where playback is. A position that fails the predicate is dropped on
// the floor (not deleted): `ended` is what forgets a finished video.
export function savePosition(email, track, time, duration) {
  const key = resumeKey(track)
  if (!key || !isResumable(time, duration)) return
  const map = readMap(email)
  map[key] = { t: time, u: Date.now() }
  writeMap(email, pruneEntries(map))
}

export function clearPosition(email, track) {
  const key = resumeKey(track)
  if (!key) return
  const map = readMap(email)
  if (!(key in map)) return
  delete map[key]
  writeMap(email, map)
}
