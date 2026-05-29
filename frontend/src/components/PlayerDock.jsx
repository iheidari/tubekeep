import { useRef, useLayoutEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { usePlayer } from '../context/usePlayer'

const fmt = (s) => {
  if (!Number.isFinite(s) || s < 0) return '0:00'
  const m = Math.floor(s / 60)
  const sec = Math.floor(s % 60)
  return `${m}:${sec.toString().padStart(2, '0')}`
}

// The persistent bottom bar. Shown on every page once something is playing, EXCEPT
// the play page (where the full-size stage owns the element). It adopts the same
// shared <video> from PlayerProvider into its thumbnail box.
function PlayerDock() {
  const {
    current,
    stageActive,
    isPlaying,
    currentTime,
    duration,
    togglePlay,
    seek,
    closePlayer,
    registerDock
  } = usePlayer()
  const navigate = useNavigate()
  const thumbRef = useRef(null)

  const visible = !!current && !stageActive

  useLayoutEffect(() => {
    if (!visible) return
    registerDock(thumbRef.current)
    return () => registerDock(null)
  }, [visible, registerDock])

  if (!visible) return null

  const expand = () => navigate(`/play/${current.downloadId}`)

  return (
    <div className="fixed bottom-0 inset-x-0 z-50 bg-surface-container-high border-t border-surface-variant shadow-lg">
      <div className="max-w-container-max mx-auto px-gutter py-2 flex items-center gap-3">
        {/* Thumbnail — hosts the shared element; music icon overlays it for audio. */}
        <button
          onClick={expand}
          title="Expand player"
          className="relative w-[72px] h-[42px] shrink-0 rounded-md overflow-hidden bg-black"
        >
          <div ref={thumbRef} className="absolute inset-0" />
          {current.isAudio && (
            <span
              className="material-symbols-outlined absolute inset-0 flex items-center justify-center text-primary-fixed-dim text-[24px] bg-gradient-to-br from-surface-container-high to-black"
              style={{ fontVariationSettings: "'FILL' 1" }}
            >
              music_note
            </span>
          )}
        </button>

        <button
          onClick={togglePlay}
          title={isPlaying ? 'Pause' : 'Play'}
          className="shrink-0 w-10 h-10 flex items-center justify-center rounded-full bg-primary text-on-primary hover:bg-primary-container transition-colors active:scale-95"
        >
          <span className="material-symbols-outlined" style={{ fontVariationSettings: "'FILL' 1" }}>
            {isPlaying ? 'pause' : 'play_arrow'}
          </span>
        </button>

        <div className="min-w-0 flex-1">
          <button
            onClick={expand}
            className="block w-full text-left truncate font-label-md text-label-md text-on-surface hover:text-primary transition-colors"
            title={current.title}
          >
            {current.title}
          </button>
          <div className="flex items-center gap-2 mt-1">
            <span className="font-label-sm text-label-sm text-secondary tabular-nums w-9 text-right">
              {fmt(currentTime)}
            </span>
            <input
              type="range"
              min={0}
              max={duration || 0}
              step="any"
              value={Math.min(currentTime, duration || 0)}
              onChange={(e) => seek(Number(e.target.value))}
              className="flex-1 h-1 accent-primary cursor-pointer"
              aria-label="Seek"
            />
            <span className="font-label-sm text-label-sm text-secondary tabular-nums w-9">
              {fmt(duration)}
            </span>
          </div>
        </div>

        <button
          onClick={expand}
          title="Expand player"
          className="hidden sm:flex shrink-0 w-9 h-9 items-center justify-center rounded-full text-on-surface-variant hover:bg-surface-container-highest transition-colors"
        >
          <span className="material-symbols-outlined">open_in_full</span>
        </button>
        <button
          onClick={closePlayer}
          title="Close player"
          className="shrink-0 w-9 h-9 flex items-center justify-center rounded-full text-on-surface-variant hover:bg-surface-container-highest transition-colors"
        >
          <span className="material-symbols-outlined">close</span>
        </button>
      </div>
    </div>
  )
}

export default PlayerDock
