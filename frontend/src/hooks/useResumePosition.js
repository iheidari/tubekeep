import { useCallback, useEffect, useLayoutEffect, useRef } from 'react'
import { clearPosition, positionToSeek, SAVE_INTERVAL_MS, savePosition } from '../lib/resume'

// "Not bound yet" sentinel. `null` is a real identity here (the anon namespace
// a logged-out /play/:id visitor writes under), so it can't double as "we
// haven't looked".
const UNBOUND = Symbol('unbound')

// Playback-position memory for the player's one media element (0XC-462), kept
// out of PlayerContext so that provider stays about *owning the element*. The
// rules all live in lib/resume; this is the bookkeeping around them — which
// track is playing, whose namespace it belongs to, whether it's been seeked,
// and when the next throttled write is due.
//
// Everything is a ref because the consumer registers its media listeners once,
// with no deps: a piece of state here would hand those listeners a stale track
// or a stale identity, which is exactly the bug this hook has to not have.
//
// `email` / `ready` come from the auth session (`ready` is `!loading`): the
// namespace isn't knowable until /api/auth/me answers, and reading or writing
// early would file the position under `anon` and lose it.
export function useResumePosition({ mediaRef, email, ready }) {
  const trackRef = useRef(null)
  const identityRef = useRef({ ready: false, email: null })
  const boundRef = useRef(UNBOUND) // identity the CURRENT track is filed under
  const lastSaveRef = useRef(0) // ms timestamp of the last write, for the throttle
  const seekedForRef = useRef(null) // streamUrl already restored — at most once per source

  // The namespace this track may touch, or `false` for "hands off". Bound the
  // first time the current track reaches storage and then frozen: logging out
  // does **not** stop the dock (App.jsx's logout never calls closePlayer), and
  // the serve route is public, so a signed-in viewer's video keeps playing
  // afterwards. Without the freeze, every later write would re-file their
  // progress under `anon` — where the next visitor on that browser resumes from
  // it — or under whoever logs in next, while their own entry silently froze at
  // the moment they logged out.
  const boundEmail = useCallback(() => {
    const { ready: settled, email: live } = identityRef.current
    if (!settled) return false
    if (boundRef.current === UNBOUND) boundRef.current = live
    return boundRef.current === live ? live : false
  }, [])

  // Persist where playback is. `throttled` is for the playback tick — the only
  // caller that can fire faster than the interval. Whether the position is
  // worth keeping at all is lib/resume's call, not ours.
  const save = useCallback(
    ({ throttled = false } = {}) => {
      const media = mediaRef.current
      const track = trackRef.current
      const to = boundEmail()
      if (!media || !track || to === false) return
      if (throttled && Date.now() - lastSaveRef.current < SAVE_INTERVAL_MS) return
      lastSaveRef.current = Date.now()
      savePosition(to, track, media.currentTime, media.duration)
    },
    [mediaRef, boundEmail],
  )

  // Seek to the saved position, at most once per stream URL. It needs both the
  // duration (the read tests the position against *this* file, and `currentTime`
  // isn't settable before metadata) and a settled session — either can land
  // last, so the consumer calls this from its metadata listener *and* from an
  // effect watching the session, and `seekedForRef` lets only the winner act.
  // Keying that ref on the stream URL rather than a per-call flag is also why
  // expanding the dock onto the stage never yanks playback backwards.
  const restore = useCallback(() => {
    const media = mediaRef.current
    const track = trackRef.current
    const to = boundEmail()
    if (!media || !track || to === false) return
    if (seekedForRef.current === track.streamUrl) return
    if (!Number.isFinite(media.duration) || media.duration <= 0) return // wait for durationchange
    seekedForRef.current = track.streamUrl
    const at = positionToSeek(to, track, {
      duration: media.duration,
      currentTime: media.currentTime,
    })
    if (at !== null) media.currentTime = at
  }, [mediaRef, boundEmail])

  // A video watched to the end is forgotten outright, so re-opening it starts
  // at 0:00 rather than at its final frame.
  const forget = useCallback(() => {
    const to = boundEmail()
    if (to === false || !trackRef.current) return
    clearPosition(to, trackRef.current)
  }, [boundEmail])

  // Adopt `track` as the one being tracked; returns false when it was already
  // current, so the consumer can skip the state update. The outgoing position is
  // flushed here rather than in an effect cleanup: by the time a cleanup ran,
  // the element's `src` would already have changed and its `currentTime` reset
  // to 0. A new track re-binds the identity — it belongs to whoever pressed play.
  const begin = useCallback(
    (track) => {
      if (trackRef.current?.downloadId === track.downloadId) return false
      save()
      trackRef.current = track
      boundRef.current = UNBOUND
      lastSaveRef.current = 0
      return true
    },
    [save],
  )

  // Nothing is playing any more (closePlayer). Flush, then forget everything
  // about the outgoing track so a later play of the same file restores again.
  const release = useCallback(() => {
    save()
    trackRef.current = null
    boundRef.current = UNBOUND
    seekedForRef.current = null
    lastSaveRef.current = 0
  }, [save])

  // Mirror the session into a ref the listeners can read, flushing under the
  // *outgoing* identity first — the same "write before the target changes" rule
  // `begin` applies to tracks. A layout effect rather than a render-time
  // assignment: it still lands before the browser can paint or fire a media
  // event, but never runs for a render React discards.
  useLayoutEffect(() => {
    const prev = identityRef.current
    if (prev.ready && (!ready || prev.email !== email)) save()
    identityRef.current = { ready, email }
  }, [ready, email, save])

  // Last-chance writes. `visibilitychange` rather than `beforeunload`, which
  // mobile Safari skips when a tab is backgrounded or swiped away; `pagehide`
  // covers the teardowns (bfcache eviction included) that never go `hidden`.
  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') save()
    }
    const onPageHide = () => save()
    document.addEventListener('visibilitychange', onVisibility)
    window.addEventListener('pagehide', onPageHide)
    return () => {
      document.removeEventListener('visibilitychange', onVisibility)
      window.removeEventListener('pagehide', onPageHide)
    }
  }, [save])

  return { begin, release, save, restore, forget }
}
