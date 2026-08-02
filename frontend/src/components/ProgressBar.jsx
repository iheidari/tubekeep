// The active-download card: thumbnail + title, a big percentage, the accent
// progress bar, and a Cancel action. Speed/ETA aren't surfaced by the SSE, so
// the card stays honest and shows only what we know.
function ProgressBar({ progress, title, thumbnail, type, onCancel }) {
  const pct = Math.max(0, Math.min(100, progress))
  const isAudio = type === 'audio'
  const kindLabel = isAudio ? 'Audio' : 'Video'

  return (
    <div className="flex justify-center py-stack-lg">
      <div className="w-full max-w-[520px] bg-surface border border-line rounded-2xl p-9 flex flex-col gap-6">
        <div className="flex items-center gap-4">
          <div className="w-24 aspect-video rounded-[10px] overflow-hidden flex-shrink-0 bg-tint flex items-center justify-center">
            {thumbnail ? (
              <img src={thumbnail} alt="" className="w-full h-full object-cover" />
            ) : (
              <span className="material-symbols-outlined text-faint text-[28px]" aria-hidden="true">
                {isAudio ? 'music_note' : 'movie'}
              </span>
            )}
          </div>
          <div className="min-w-0">
            <div className="font-semibold text-[15px] text-ink truncate">
              {title || 'Your download'}
            </div>
            <div className="text-[12.5px] text-muted mt-0.5">{kindLabel} download</div>
          </div>
        </div>

        <div className="flex flex-col gap-3">
          <div className="flex items-baseline justify-between">
            <span className="flex items-center gap-2 font-semibold text-[13.5px] text-muted">
              <span className="material-symbols-outlined text-[18px] text-pop" aria-hidden="true">
                downloading
              </span>
              Downloading…
            </span>
            <span className="font-bold text-[30px] leading-none tracking-[-0.02em] text-ink tabular-nums">
              {Math.round(pct)}
              <span className="text-[18px]">%</span>
            </span>
          </div>
          <div className="w-full h-2 rounded-md bg-tint overflow-hidden">
            <div
              className="h-full bg-pop rounded-md transition-[width] duration-300"
              style={{ width: `${pct}%` }}
            />
          </div>
        </div>

        {onCancel ? (
          <button
            type="button"
            onClick={onCancel}
            className="self-start bg-transparent border border-line2 text-muted font-semibold text-[13px] px-[18px] py-2.5 rounded-[9px] hover:bg-tint transition-colors"
          >
            Cancel
          </button>
        ) : null}
      </div>
    </div>
  )
}

export default ProgressBar
