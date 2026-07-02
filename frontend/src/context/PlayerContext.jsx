import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { fileUrl, isAudioFile } from '../lib/media'
import { PlayerContext } from './playerContext.js'

// Build the player's view of a download. `download` comes from history/cold-lookup.
function toTrack(download, apiUrl) {
  return {
    downloadId: download.downloadId,
    title: download.title,
    filename: download.filename,
    isAudio: isAudioFile(download.filename),
    streamUrl: fileUrl(apiUrl, download.downloadId, download.filename),
    downloadUrl: fileUrl(apiUrl, download.downloadId, download.filename, { download: true }),
  }
}

export function PlayerProvider({ children }) {
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
    const onPause = () => setIsPlaying(false)
    const onTime = () => setCurrentTime(media.currentTime || 0)
    const onMeta = () => setDuration(media.duration || 0)
    const onError = () => {
      if (media.currentSrc) setLoadError(true)
    }
    media.addEventListener('play', onPlay)
    media.addEventListener('pause', onPause)
    media.addEventListener('timeupdate', onTime)
    media.addEventListener('loadedmetadata', onMeta)
    media.addEventListener('durationchange', onMeta)
    media.addEventListener('error', onError)
    return () => {
      media.removeEventListener('play', onPlay)
      media.removeEventListener('pause', onPause)
      media.removeEventListener('timeupdate', onTime)
      media.removeEventListener('loadedmetadata', onMeta)
      media.removeEventListener('durationchange', onMeta)
      media.removeEventListener('error', onError)
    }
  }, [])

  const playTrack = useCallback((download, apiUrl) => {
    const track = toTrack(download, apiUrl)
    setCurrent((prev) => {
      if (prev?.downloadId === track.downloadId) return prev
      return track
    })
    setLoadError(false)
  }, [])

  const closePlayer = useCallback(() => {
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
  }, [])

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

  const value = {
    current,
    stageActive,
    isPlaying,
    currentTime,
    duration,
    loadError,
    playTrack,
    closePlayer,
    togglePlay,
    seek,
    registerStage,
    registerDock,
  }

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
