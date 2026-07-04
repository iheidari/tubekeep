import { useEffect, useState } from 'react'
import { useCloudMove } from '../hooks/useCloudMove'
import { FILE_EXPIRY_MS } from '../lib/media'

// A move must have at least this much runway before the file's expiry, so it
// can't be started only to have the hourly cleanup yank the source mid-upload.
const MOVE_CUTOFF_MS = 15 * 60 * 1000

// ms of runway left before this file is too close to expiry to safely move.
function moveRunwayMs(download) {
  if (!download?.createdAt) return Number.POSITIVE_INFINITY
  const createdAt = new Date(download.createdAt).getTime()
  if (Number.isNaN(createdAt)) return Number.POSITIVE_INFINITY
  return createdAt + FILE_EXPIRY_MS - Date.now()
}

// "Move to Dropbox" control for a completed download. Renders nothing when the
// server hasn't configured a cloud provider. Handles the whole flow inline:
// connect → upload progress → moved / error (with a "download instead" fallback).
function MoveToCloud({ download, downloadHref, onMoved }) {
  const { available, phase, progress, error, move } = useCloudMove(download, { onMoved })
  const [, setTick] = useState(0)

  // Flip the button to "expiring soon" exactly when the runway crosses the
  // cutoff, without polling — schedule a single re-render at that moment.
  const runway = moveRunwayMs(download)
  useEffect(() => {
    const untilCutoff = runway - MOVE_CUTOFF_MS
    if (!Number.isFinite(untilCutoff) || untilCutoff <= 0) return
    const timer = setTimeout(() => setTick((v) => v + 1), untilCutoff + 500)
    return () => clearTimeout(timer)
  }, [runway])

  // Hidden until we know a provider is enabled (avoids a flash then disappear).
  if (available !== true) return null

  // Too close to expiry to safely start a move — disable and nudge to download.
  if (phase === 'idle' && runway < MOVE_CUTOFF_MS) {
    return (
      <div className="flex flex-col items-stretch gap-1 min-w-[9rem]">
        <button
          type="button"
          disabled
          title="This file is about to expire — download it to your device instead."
          className="flex items-center justify-center gap-1 text-on-surface-variant/60 font-label-sm text-label-sm whitespace-nowrap border border-outline-variant px-3 py-1 rounded-full cursor-default"
        >
          <span className="material-symbols-outlined text-[16px]">cloud_off</span>
          Move to Dropbox
        </button>
        <span className="font-label-sm text-label-sm text-on-surface-variant/70 text-center">
          Expiring soon
        </span>
      </div>
    )
  }

  if (phase === 'complete') {
    return (
      <span className="flex items-center gap-1 text-tertiary font-label-sm text-label-sm whitespace-nowrap">
        <span
          className="material-symbols-outlined text-[16px]"
          style={{ fontVariationSettings: "'FILL' 1" }}
        >
          cloud_done
        </span>
        Moved
      </span>
    )
  }

  if (phase === 'error') {
    const isQuota = error?.code === 'quota'
    return (
      <div className="flex flex-col items-end gap-1 text-right">
        <p className="font-label-sm text-label-sm text-error max-w-[16rem]">
          {error?.message || 'Move failed'}
        </p>
        <div className="flex items-center gap-2">
          {downloadHref && (
            <a
              href={downloadHref}
              className="font-label-sm text-label-sm text-primary hover:underline whitespace-nowrap"
            >
              {isQuota ? 'Download instead' : 'Download to device'}
            </a>
          )}
          <button
            type="button"
            onClick={move}
            className="font-label-sm text-label-sm text-primary hover:underline whitespace-nowrap"
          >
            Try again
          </button>
        </div>
      </div>
    )
  }

  const busy = phase !== 'idle'
  const PHASE_LABELS = { connecting: 'Connecting…', starting: 'Starting…', queued: 'Queued…' }
  const label =
    phase === 'uploading'
      ? `Uploading ${Math.round(progress)}%`
      : PHASE_LABELS[phase] || 'Move to Dropbox'

  return (
    <div className="flex flex-col items-stretch gap-1 min-w-[9rem]">
      <button
        type="button"
        onClick={move}
        disabled={busy}
        className="flex items-center justify-center gap-1 text-primary font-label-sm text-label-sm whitespace-nowrap border border-primary px-3 py-1 rounded-full hover:bg-primary/5 transition-colors active:scale-95 disabled:opacity-70 disabled:cursor-default disabled:active:scale-100"
      >
        <span
          className={`material-symbols-outlined text-[16px] ${busy ? 'animate-spin' : ''}`}
          style={busy ? undefined : { fontVariationSettings: "'FILL' 1" }}
        >
          {busy ? 'progress_activity' : 'cloud_upload'}
        </span>
        {label}
      </button>
      {phase === 'uploading' && (
        <div className="h-1 w-full bg-surface-variant rounded-full overflow-hidden">
          <div
            className="h-full bg-primary transition-[width] duration-200"
            style={{ width: `${progress}%` }}
          />
        </div>
      )}
    </div>
  )
}

export default MoveToCloud
