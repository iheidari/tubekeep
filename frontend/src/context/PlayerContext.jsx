import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { fileUrl, mediaKind } from '../lib/media'
import {
  clearPosition,
  MIN_POSITION_SECONDS,
  readPosition,
  resumeKey,
  SAVE_INTERVAL_MS,
  savePosition,
} from '../lib/resume'
import { PlayerContext } from './playerContext.js'
import { useAuth } from './useAuth.js'

// Build the player's view of a download. `download` comes from history/cold-lookup.
// `sourceKey` rides along for resume only: it's what keeps your place across a
// re-download, and the public /play meta endpoint doesn't carry one (so an
// anonymous viewer falls back to `downloadId`).
function toTrack(download, apiUrl) {
  return {
    downloadId: download.downloadId,
    sourceKey: download.sourceKey || null,
    title: download.title,
    filename: download.filename,
    isAudio: mediaKind(download) === 'audio',
    streamUrl: fileUrl(apiUrl, download.downloadId, download.filename),
    downloadUrl: fileUrl(apiUrl, download.downloadId, download.filename, { download: true }),
  }
}

export function PlayerProvider({ children }) {
  // Resume positions are namespaced per identity (see lib/resume), so the
  // player needs to know who's watching. `loading` matters as much as `user`:
  // reading or writing before /api/auth/me settles would file the position
  // under `anon` and lose it.
  const { user, loading: authLoading } = useAuth()
  const authEmail = user?.email || null

  // The ONE media element. Rendered once below and physically moved between
  // hosts with appendChild — moving a node never resets playback, so audio/video
  // keeps going across route changes. Remounting (what the router does to pages)
  // is exactly what we avoid.
  const mediaRef = useRef(null)
  const homeRef = useRef(null) // hidden parking spot when no host is mounted
  const stageRef = useRef(null) // full-size slot on the play page
  const dockRef = useRef(null) // thumbnail box in the bottom bar

  const [current, setCurrent] = useState(null)
  const [stageActive, setStageActive] = useState(false)
  const [isPlaying, setIsPlaying] = useState(false)
  const [currentTime, setCurrentTime] = useState(0)
  const [duration, setDuration] = useState(0)
  const [loadError, setLoadError] = useState(false)
  const [playbackRate, setPlaybackRateState] = useState(1)
  // Loading a new source resets the element's playbackRate to 1, so the chosen
  // rate is mirrored here and reapplied on loadedmetadata (see below). A ref
  // holds it for the metadata listener, whose effect runs once with no deps.
  const rateRef = useRef(1)

  // Resume bookkeeping, all in refs: the media listeners below are registered
  // once (no deps) and the flush points are stable callbacks, so none of them
  // can close over a stale track or identity.
  const trackRef = useRef(null) // mirrors `current` — the only two setters keep it in sync
  const authRef = useRef({ ready: false, email: null })
  const lastSaveRef = useRef(0) // ms timestamp of the last throttled write
  const resumedForRef = useRef(null) // streamUrl already seeked, so it happens once per source
  // Layout effect, not render-time assignment: it still lands before the
  // browser can paint (or fire a media event) but never runs for a render React
  // discards.
  useLayoutEffect(() => {
    authRef.current = { ready: !authLoading, email: authEmail }
  }, [authLoading, authEmail])

  // Persist where playback is right now. Called on pause, on a source change,
  // on close, when the tab is hidden, and on the playback throttle. The
  // predicate lives in lib/resume, so a position too early or too near the end
  // is simply not recorded.
  const flushPosition = useCallback(() => {
    const media = mediaRef.current
    const track = trackRef.current
    const { ready, email } = authRef.current
    if (!media || !track || !ready) return
    lastSaveRef.current = Date.now()
    savePosition(email, resumeKey(track), media.currentTime, media.duration)
  }, [])

  // Move the element to the most specific mounted host (stage > dock > home).
  const placeMedia = useCallback(() => {
    const media = mediaRef.current
    if (!media) return
    const host = stageRef.current || dockRef.current || homeRef.current
    if (host && media.parentNode !== host) host.appendChild(media)
  }, [])

  const registerStage = useCallback(
    (el) => {
      stageRef.current = el
      setStageActive(!!el)
      placeMedia()
    },
    [placeMedia],
  )

  const registerDock = useCallback(
    (el) => {
      dockRef.current = el
      placeMedia()
    },
    [placeMedia],
  )

  // Native controls only when full-size; the dock drives playback with its own UI.
  // Styling is imperative (one shared element, different shape per host) so React's
  // render never fights these class changes.
  useLayoutEffect(() => {
    const media = mediaRef.current
    if (!media) return
    media.controls = stageActive
    if (stageActive && current?.isAudio) {
      // Audio: collapse the (empty) picture area so only the control bar shows
      // over the page's gradient + music-note background.
      media.className = 'absolute bottom-6 left-1/2 -translate-x-1/2 w-full max-w-xl px-6'
    } else if (stageActive) {
      media.className = 'w-full h-full object-contain bg-black'
    } else {
      media.className = 'w-full h-full object-cover bg-black'
    }
  }, [stageActive, current?.isAudio, current])

  // (Re)start playback whenever the source changes.
  useEffect(() => {
    const media = mediaRef.current
    if (!media || !current?.streamUrl) return
    media.play().catch(() => {})
  }, [current?.streamUrl])

  // Mirror the element's state into React for the dock UI.
  useEffect(() => {
    const media = mediaRef.current
    if (!media) return
    const onPlay = () => setIsPlaying(true)
    const onPause = () => {
      setIsPlaying(false)
      flushPosition()
    }
    const onTime = () => {
      setCurrentTime(media.currentTime || 0)
      if (Date.now() - lastSaveRef.current >= SAVE_INTERVAL_MS) flushPosition()
    }
    // A video watched to the end is forgotten outright, so re-opening it starts
    // at 0:00 rather than at its final frame.
    const onEnded = () => {
      const { ready, email } = authRef.current
      if (ready) clearPosition(email, resumeKey(trackRef.current))
    }
    const onMeta = () => {
      setDuration(media.duration || 0)
      // A fresh source starts at 1×; restore the user's chosen rate.
      media.playbackRate = rateRef.current
    }
    // Trust the element's own MediaError: it's set on a real failure (e.g. an
    // expired file 404ing) and cleared by load() on teardown, so this shows the
    // friendly "unable to play" stage without false positives — and without
    // depending on currentSrc, which can be cleared for an expired source.
    const onError = () => {
      if (media.error) setLoadError(true)
    }
    media.addEventListener('play', onPlay)
    media.addEventListener('pause', onPause)
    media.addEventListener('timeupdate', onTime)
    media.addEventListener('ended', onEnded)
    media.addEventListener('loadedmetadata', onMeta)
    media.addEventListener('durationchange', onMeta)
    media.addEventListener('error', onError)
    return () => {
      media.removeEventListener('play', onPlay)
      media.removeEventListener('pause', onPause)
      media.removeEventListener('timeupdate', onTime)
      media.removeEventListener('ended', onEnded)
      media.removeEventListener('loadedmetadata', onMeta)
      media.removeEventListener('durationchange', onMeta)
      media.removeEventListener('error', onError)
    }
  }, [flushPosition])

  // Restore the saved position, once per source. Both conditions must hold —
  // the element must know its duration (the read-side clamp needs it, and
  // `currentTime` isn't settable before metadata) and the session must have
  // settled (it namespaces the storage) — and either can land last, so this
  // tries immediately and again on each metadata event until it succeeds.
  // `resumedForRef` is keyed on the stream URL rather than a per-effect flag, so
  // a re-run (a login resolving mid-playback) can't seek a second time; it's
  // also why expanding the dock onto the stage never yanks playback backwards.
  useEffect(() => {
    const media = mediaRef.current
    const streamUrl = current?.streamUrl
    if (!media || !streamUrl || authLoading) return

    const restore = () => {
      if (resumedForRef.current === streamUrl) return
      if (!Number.isFinite(media.duration) || media.duration <= 0) return // wait for durationchange
      resumedForRef.current = streamUrl
      const saved = readPosition(authEmail, resumeKey(current), media.duration)
      // Only while playback is still effectively at the start: if auth resolved
      // late and the viewer is already watching, leave them where they are.
      if (saved !== null && media.currentTime < MIN_POSITION_SECONDS) media.currentTime = saved
    }

    restore()
    media.addEventListener('loadedmetadata', restore)
    media.addEventListener('durationchange', restore)
    return () => {
      media.removeEventListener('loadedmetadata', restore)
      media.removeEventListener('durationchange', restore)
    }
  }, [current, authLoading, authEmail])

  // Mobile Safari doesn't reliably fire `beforeunload` when a tab is
  // backgrounded or swiped away, so this is the last write we're guaranteed.
  useEffect(() => {
    const onHidden = () => {
      if (document.visibilityState === 'hidden') flushPosition()
    }
    document.addEventListener('visibilitychange', onHidden)
    return () => document.removeEventListener('visibilitychange', onHidden)
  }, [flushPosition])

  // `trackRef` is updated here and in closePlayer — the only two setters of
  // `current` — so the media listeners always see the track that's actually
  // loaded. Switching sources flushes the outgoing position first: by the time
  // an effect cleanup ran, the element's `src` would already have changed and
  // its `currentTime` reset to 0.
  const playTrack = useCallback(
    (download, apiUrl) => {
      const track = toTrack(download, apiUrl)
      if (trackRef.current?.downloadId !== track.downloadId) {
        flushPosition()
        trackRef.current = track
        setCurrent(track)
      }
      setLoadError(false)
    },
    [flushPosition],
  )

  const closePlayer = useCallback(() => {
    flushPosition()
    trackRef.current = null
    resumedForRef.current = null
    const media = mediaRef.current
    if (media) {
      media.pause()
      media.removeAttribute('src')
      media.load()
    }
    setCurrent(null)
    setIsPlaying(false)
    setCurrentTime(0)
    setDuration(0)
    setLoadError(false)
  }, [flushPosition])

  const togglePlay = useCallback(() => {
    const media = mediaRef.current
    if (!media) return
    if (media.paused) media.play().catch(() => {})
    else media.pause()
  }, [])

  const seek = useCallback((time) => {
    const media = mediaRef.current
    if (media && Number.isFinite(time)) media.currentTime = time
  }, [])

  const setRate = useCallback((rate) => {
    if (!Number.isFinite(rate)) return
    rateRef.current = rate
    const media = mediaRef.current
    if (media) media.playbackRate = rate
    setPlaybackRateState(rate)
  }, [])

  // Callbacks are useCallback-stable, so this only re-identifies when the state
  // values actually change — sibling HistoryContext does the same.
  const value = useMemo(
    () => ({
      current,
      stageActive,
      isPlaying,
      currentTime,
      duration,
      loadError,
      playbackRate,
      playTrack,
      closePlayer,
      togglePlay,
      seek,
      setRate,
      registerStage,
      registerDock,
    }),
    [
      current,
      stageActive,
      isPlaying,
      currentTime,
      duration,
      loadError,
      playbackRate,
      playTrack,
      closePlayer,
      togglePlay,
      seek,
      setRate,
      registerStage,
      registerDock,
    ],
  )

  return (
    <PlayerContext.Provider value={value}>
      {/* Parking spot: keeps the element in the document (so playback survives)
          whenever neither the stage nor the dock is mounted. */}
      <div ref={homeRef} className="hidden" aria-hidden="true">
        {/* biome-ignore lint/a11y/useMediaCaption: playing user-downloaded media with no caption track available */}
        <video ref={mediaRef} src={current?.streamUrl || undefined} playsInline />
      </div>
      {children}
    </PlayerContext.Provider>
  )
}
