import { useState } from 'react'
import { downloadBlockReason, formatDuration, formatFileSize, isUnlimitedQuota } from '../lib/media'
import BackLink from './BackLink'

// Id linking the "won't fit" reason to its Get button via aria-describedby.
// Single-sourced so the note and the button reference the exact same id.
const noSpaceId = (formatId) => `nospace-${formatId}`

// Why an oversized format can't be downloaded — either the user's storage quota
// or the server's free disk (video + audio blocks render it identically), wired
// to its button through noSpaceId.
function NoSpaceNote({ formatId, reason }) {
  return (
    <p id={noSpaceId(formatId)} className="text-[11.5px] text-error font-semibold mt-0.5">
      {reason}
    </p>
  )
}

// One selectable format row, shared by the video and audio lists — they differ
// only in what goes in the badge/title, the extension fallback, and how the Get
// button is styled. The block/disable semantics (both backend guards, via
// downloadBlockReason) and the a11y wiring live here once, so the two lists
// can't drift apart.
function FormatOption({
  format,
  badge,
  title,
  extFallback,
  isBest,
  disk,
  startingFormat,
  buttonClass,
  onGet,
}) {
  const isStarting = startingFormat === format.formatId
  const blocked = downloadBlockReason(format.filesize, disk)
  const inactive = startingFormat !== null || blocked !== null

  return (
    <div className="flex items-center justify-between gap-3 py-4 border-b border-line">
      <div className="flex items-center gap-3.5 min-w-0">
        <span
          className={`min-w-[52px] text-center rounded-lg font-bold text-[13px] px-2 py-[7px] ${
            isBest ? 'bg-fill text-on-fill' : 'bg-tint text-muted'
          }`}
        >
          {badge}
        </span>
        <div className="min-w-0">
          <p className="font-semibold text-[14px] text-ink truncate">{title}</p>
          <p className="text-[12px] text-muted">
            {(format.ext || extFallback).toUpperCase()} · {formatFileSize(format.filesize)}
            {isBest ? (
              <>
                {' · '}
                <span className="text-pop font-semibold">best</span>
              </>
            ) : null}
          </p>
          {blocked ? <NoSpaceNote formatId={format.formatId} reason={blocked} /> : null}
        </div>
      </div>
      <button
        type="button"
        onClick={() => {
          // aria-disabled, not disabled: a `disabled` button is skipped by the
          // tab order, so its aria-describedby reason never reaches screen
          // reader users (and focus would be dropped mid-flow when a click
          // disables it). Guard the action here instead.
          if (inactive) return
          onGet()
        }}
        aria-disabled={inactive}
        aria-describedby={blocked ? noSpaceId(format.formatId) : undefined}
        className={`flex items-center gap-1.5 px-3.5 py-2.5 rounded-[9px] font-semibold text-[12.5px] transition-all flex-shrink-0 ${
          inactive ? 'opacity-50 cursor-not-allowed' : 'active:scale-95'
        } ${buttonClass}`}
      >
        <span
          aria-hidden="true"
          className={`material-symbols-outlined text-[16px] ${isStarting ? 'animate-spin' : ''}`}
        >
          {isStarting ? 'progress_activity' : 'download'}
        </span>
        {isStarting ? 'Starting…' : 'Get'}
      </button>
    </div>
  )
}

function FormatSelector({ info, onDownload, startingFormat = null, disk = null }) {
  const [keep, setKeep] = useState(false)

  const quota = disk?.quota || null
  const unlimited = quota ? isUnlimitedQuota(quota.max) : false
  const usedPct =
    quota && !unlimited && quota.max > 0
      ? Math.min(100, Math.round((quota.used / quota.max) * 100))
      : 0

  const getHeight = (res) => {
    if (!res) return 0
    const match = res.match(/(\d+)x(\d+)/)
    return match ? parseInt(match[2], 10) : 0
  }

  const heightLabel = (res) => {
    const h = getHeight(res)
    if (!h) return res || '—'
    return `${h}p`
  }

  const qualityName = (h) => {
    if (h >= 2160) return 'Ultra HD 4K'
    if (h >= 1440) return 'Quad HD'
    if (h >= 1080) return 'Full HD'
    if (h >= 720) return 'HD Ready'
    if (h >= 480) return 'Standard'
    if (h >= 360) return 'Low'
    return 'SD'
  }

  // Build a unified video list: pick best format per unique resolution,
  // preferring h264/avc for compatibility and video-only (mergeable) for highest qualities.
  const buildVideoOptions = () => {
    const videoFormats = (info.formats?.video || []).map((f) => ({ ...f, _type: 'video' }))
    const combinedFormats = (info.formats?.combined || []).map((f) => ({ ...f, _type: 'combined' }))
    const all = [...videoFormats, ...combinedFormats]

    const sorted = [...all].sort((a, b) => {
      const aIsH264 = /avc|h264/i.test(a.vcodec || '')
      const bIsH264 = /avc|h264/i.test(b.vcodec || '')
      if (aIsH264 && !bIsH264) return -1
      if (!aIsH264 && bIsH264) return 1
      return getHeight(b.resolution) - getHeight(a.resolution)
    })

    const seen = new Map()
    sorted.forEach((format) => {
      const res = format.resolution
      if (!res || res === 'audio only') return
      if (!seen.has(res)) seen.set(res, format)
    })

    return Array.from(seen.values()).sort(
      (a, b) => getHeight(b.resolution) - getHeight(a.resolution),
    )
  }

  // Build audio options sorted by bitrate descending, dedupe by abr.
  const buildAudioOptions = () => {
    const audio = info.formats?.audio || []
    const seen = new Map()
    ;[...audio]
      .sort((a, b) => (b.abr || 0) - (a.abr || 0))
      .forEach((f) => {
        const key = Math.round(f.abr || 0)
        if (!seen.has(key)) seen.set(key, f)
      })
    return Array.from(seen.values())
  }

  const videoOptions = buildVideoOptions()
  const audioOptions = buildAudioOptions()

  const sourceName = (() => {
    try {
      const host = new URL(info.originalUrl).hostname.replace(/^www\./, '')
      if (host.includes('youtube') || host.includes('youtu.be')) return 'YouTube'
      return host
    } catch {
      return 'Web'
    }
  })()

  return (
    <div className="max-w-4xl mx-auto">
      <BackLink />

      {/* Video Header Section */}
      <section className="mb-stack-md">
        <div className="flex flex-col md:flex-row gap-6 md:items-center">
          <div className="relative w-full md:w-[280px] aspect-video flex-shrink-0">
            <img
              src={info.thumbnail}
              alt={info.title}
              className="w-full h-full object-cover rounded-xl"
            />
            {info.duration ? (
              <div className="absolute bottom-2 right-2 bg-black/80 text-white text-[11px] px-1.5 py-0.5 rounded font-bold">
                {formatDuration(info.duration)}
              </div>
            ) : null}
          </div>
          <div className="flex flex-col justify-center gap-3 min-w-0">
            <div className="flex gap-2.5 items-center flex-wrap">
              <span className="bg-fill text-on-fill text-[10px] px-2.5 py-1 rounded-full font-bold tracking-[0.06em]">
                {sourceName.toUpperCase()}
              </span>
              {info.uploadDate ? (
                <span className="font-label-md text-[12.5px] text-faint">
                  Uploaded {info.uploadDate}
                </span>
              ) : null}
            </div>
            <h2 className="font-bold text-[26px] leading-[1.15] tracking-[-0.02em] text-ink">
              {info.title}
            </h2>
            {info.uploader ? (
              <div className="flex items-center gap-2.5">
                <div className="w-[34px] h-[34px] rounded-full bg-line flex items-center justify-center text-muted">
                  <span className="material-symbols-outlined text-[22px]" aria-hidden="true">
                    person
                  </span>
                </div>
                <div>
                  <p className="font-semibold text-[13.5px] text-ink leading-tight">
                    {info.uploader}
                  </p>
                  <p className="text-[12px] text-faint leading-tight">Source: {sourceName}</p>
                </div>
              </div>
            ) : null}
          </div>
        </div>
      </section>

      {/* Keep-forever switch — applies to whichever format is downloaded next */}
      <button
        type="button"
        role="switch"
        aria-checked={keep}
        onClick={() => setKeep((v) => !v)}
        className="w-full mb-stack-md flex items-center gap-3.5 bg-surface border border-line rounded-xl px-4 py-3.5 text-left"
      >
        <span
          className="material-symbols-outlined text-ink text-[22px]"
          style={{ fontVariationSettings: "'FILL' 1, 'wght' 500" }}
          aria-hidden="true"
        >
          push_pin
        </span>
        <span className="flex-1 min-w-0">
          <span className="block font-semibold text-[14px] text-ink">Keep forever</span>
          <span className="block text-[12.5px] text-muted">
            Skip the 24-hour auto-cleanup for this download.
          </span>
        </span>
        <span
          className={`w-11 h-[26px] rounded-full relative flex-shrink-0 transition-colors ${
            keep ? 'bg-pop' : 'bg-line2'
          }`}
        >
          <span
            className={`absolute top-[3px] w-5 h-5 rounded-full bg-surface transition-all ${
              keep ? 'left-[21px]' : 'left-[3px]'
            }`}
          />
        </span>
      </button>

      {/* Your storage — the per-account quota that drives the disable check below.
          The server's own free disk is a second, separate backstop and isn't the
          user's business unless it actually blocks a format (see NoSpaceNote). */}
      {quota ? (
        <div className="mb-stack-md bg-surface border border-line rounded-xl px-4 py-3.5">
          <div className="flex items-center gap-2.5 mb-2 flex-wrap">
            <span className="material-symbols-outlined text-ink text-[20px]" aria-hidden="true">
              hard_drive
            </span>
            <p id="quota-label" className="font-semibold text-[13.5px] text-ink">
              Your storage
            </p>
            <p className="ml-auto text-[12.5px] text-muted">
              {unlimited ? (
                <>{formatFileSize(quota.used)} used · unlimited</>
              ) : (
                <>
                  {formatFileSize(quota.remaining)} left of {formatFileSize(quota.max)} ·{' '}
                  {formatFileSize(quota.used)} used
                </>
              )}
            </p>
          </div>
          {unlimited ? null : (
            <div
              // A gauge, not a bare bar: without a role + value the fill is
              // invisible to assistive tech (its meaning is carried by width
              // and colour alone). progressbar is used over meter for screen
              // reader support; aria-valuetext restates the bytes so the
              // percentage isn't the only thing announced.
              role="progressbar"
              aria-labelledby="quota-label"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={usedPct}
              aria-valuetext={`${usedPct}% used — ${formatFileSize(quota.used)} of ${formatFileSize(
                quota.max,
              )}, ${formatFileSize(quota.remaining)} left`}
              className="h-1.5 w-full rounded-full bg-line2 overflow-hidden"
            >
              <div
                className={`h-full rounded-full ${usedPct >= 90 ? 'bg-pop' : 'bg-fill'}`}
                style={{ width: `${usedPct}%` }}
              />
            </div>
          )}
        </div>
      ) : null}

      {/* Options Grid */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-stack-lg">
        {/* Video Options */}
        <section>
          <div className="flex items-center gap-2 mb-3">
            <span className="material-symbols-outlined text-ink text-[20px]" aria-hidden="true">
              movie
            </span>
            <h3 className="font-bold text-[16px] text-ink">Video</h3>
          </div>
          {videoOptions.length === 0 ? (
            <p className="text-label-sm text-muted py-4">No video formats available.</p>
          ) : (
            <div className="flex flex-col">
              {videoOptions.map((format, idx) => {
                const isBest = idx === 0
                return (
                  <FormatOption
                    key={format.formatId}
                    format={format}
                    badge={heightLabel(format.resolution)}
                    title={qualityName(getHeight(format.resolution))}
                    extFallback="mp4"
                    isBest={isBest}
                    disk={disk}
                    startingFormat={startingFormat}
                    buttonClass={
                      isBest
                        ? 'bg-fill text-on-fill'
                        : 'bg-surface text-ink border border-line2 hover:bg-tint'
                    }
                    onGet={() => onDownload(format.formatId, format._type, keep, format.filesize)}
                  />
                )
              })}
            </div>
          )}
        </section>

        {/* Audio Only */}
        <section>
          <div className="flex items-center gap-2 mb-3">
            <span className="material-symbols-outlined text-ink text-[20px]" aria-hidden="true">
              graphic_eq
            </span>
            <h3 className="font-bold text-[16px] text-ink">Audio</h3>
          </div>
          {audioOptions.length === 0 ? (
            <p className="text-label-sm text-muted py-4">No audio formats available.</p>
          ) : (
            <div className="flex flex-col">
              {audioOptions.map((format, idx) => {
                const abr = Math.round(format.abr || 0)
                return (
                  <FormatOption
                    key={format.formatId}
                    format={format}
                    badge={abr ? `${abr}k` : (format.ext || 'aud').toUpperCase()}
                    title={idx === 0 ? 'High Quality' : 'Standard'}
                    extFallback="m4a"
                    isBest={idx === 0}
                    disk={disk}
                    startingFormat={startingFormat}
                    buttonClass="bg-surface text-ink border border-ink hover:bg-tint"
                    onGet={() => onDownload(format.formatId, 'audio', keep, format.filesize)}
                  />
                )
              })}
              <div className="flex items-center gap-2.5 py-3.5 text-faint">
                <span className="material-symbols-outlined text-[18px]" aria-hidden="true">
                  info
                </span>
                <p className="text-[12px]">Audio extraction may take a moment under load.</p>
              </div>
            </div>
          )}
        </section>
      </div>
    </div>
  )
}

export default FormatSelector
