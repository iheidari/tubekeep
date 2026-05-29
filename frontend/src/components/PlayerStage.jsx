import { useRef, useLayoutEffect } from 'react'
import { usePlayer } from '../context/usePlayer'

// Full-size host for the shared media element on the play page. It doesn't render
// the <video> itself — it adopts the persistent one from PlayerProvider, so leaving
// the page hands playback back to the dock instead of tearing it down.
function PlayerStage() {
  const { current, loadError, registerStage } = usePlayer()
  const slotRef = useRef(null)

  useLayoutEffect(() => {
    registerStage(slotRef.current)
    return () => registerStage(null)
  }, [registerStage])

  const isAudio = current?.isAudio

  return (
    <div className="relative aspect-video bg-black rounded-xl overflow-hidden shadow-lg">
      {isAudio && !loadError && (
        <div className="absolute inset-0 flex flex-col items-center justify-center bg-gradient-to-br from-surface-container-high to-black pointer-events-none">
          <span
            className="material-symbols-outlined text-[96px] text-primary-fixed-dim"
            style={{ fontVariationSettings: "'FILL' 1" }}
          >
            music_note
          </span>
        </div>
      )}

      {loadError && (
        <div className="absolute inset-0 z-10 flex flex-col items-center justify-center text-white text-center p-6 gap-3 bg-black">
          <span className="material-symbols-outlined text-[48px] text-error">error</span>
          <p className="font-body-md text-body-md">
            Unable to play this file. It may have expired or been deleted.
          </p>
          {current?.downloadUrl && (
            <a
              href={current.downloadUrl}
              download={current.filename}
              className="bg-primary text-on-primary px-4 py-2 rounded-lg font-label-md text-label-md inline-flex items-center gap-2 hover:bg-primary-container transition-colors"
            >
              <span className="material-symbols-outlined text-[18px]">download</span>
              Download instead
            </a>
          )}
        </div>
      )}

      {/* The persistent <video> element is appended here by PlayerProvider. */}
      <div ref={slotRef} className="absolute inset-0" />
    </div>
  )
}

export default PlayerStage
