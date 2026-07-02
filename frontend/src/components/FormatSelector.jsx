import { useState } from 'react'
import { formatFileSize } from '../lib/media'
import BackLink from './BackLink'

function FormatSelector({ info, onDownload, startingFormat = null }) {
  const [keep, setKeep] = useState(false)

  const formatDuration = (seconds) => {
    if (!seconds && seconds !== 0) return ''
    const mins = Math.floor(seconds / 60)
    const secs = seconds % 60
    return `${mins}:${secs.toString().padStart(2, '0')}`
  }

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
      <section className="mb-stack-lg">
        <div className="bg-surface-container-lowest border border-surface-variant rounded-xl overflow-hidden flex flex-col md:flex-row gap-6 p-4">
          <div className="relative aspect-video md:w-80 flex-shrink-0">
            <img
              src={info.thumbnail}
              alt={info.title}
              className="w-full h-full object-cover rounded-lg shadow-sm"
            />
            {info.duration ? (
              <div className="absolute bottom-2 right-2 bg-black/80 text-white text-[10px] px-1.5 py-0.5 rounded font-bold">
                {formatDuration(info.duration)}
              </div>
            ) : null}
          </div>
          <div className="flex flex-col justify-center gap-3 min-w-0">
            <div className="flex gap-2 items-center flex-wrap">
              <span className="bg-primary text-on-primary text-[10px] px-2 py-0.5 rounded-full font-bold tracking-wider">
                {sourceName.toUpperCase()}
              </span>
              {info.uploadDate ? (
                <span className="text-label-sm text-secondary">Uploaded {info.uploadDate}</span>
              ) : null}
            </div>
            <h2 className="font-headline-md text-headline-md text-on-surface leading-tight">
              {info.title}
            </h2>
            {info.uploader ? (
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-full bg-surface-container-high flex items-center justify-center text-secondary">
                  <span className="material-symbols-outlined">account_circle</span>
                </div>
                <div>
                  <p className="font-label-md text-label-md text-on-surface">{info.uploader}</p>
                  <p className="text-label-sm text-secondary">Source: {sourceName}</p>
                </div>
              </div>
            ) : null}
          </div>
        </div>
      </section>

      {/* Keep-forever toggle — applies to whichever format is downloaded next */}
      <label className="mb-stack-md flex items-center gap-3 bg-surface-container-lowest border border-surface-variant rounded-xl p-4 cursor-pointer select-none hover:shadow-sm transition-shadow">
        <input
          type="checkbox"
          checked={keep}
          onChange={(e) => setKeep(e.target.checked)}
          className="w-5 h-5 accent-primary flex-shrink-0"
        />
        <span className="material-symbols-outlined text-primary">push_pin</span>
        <span className="min-w-0">
          <span className="block font-label-md text-label-md text-on-surface">Keep forever</span>
          <span className="block font-label-sm text-label-sm text-secondary">
            Don't auto-delete this download after 24 hours.
          </span>
        </span>
      </label>

      {/* Options Grid */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-stack-md">
        {/* Video Options */}
        <section className="bg-surface-container-lowest border border-surface-variant rounded-xl p-6 shadow-sm space-y-4">
          <div className="flex items-center gap-2 mb-4">
            <span className="material-symbols-outlined text-primary">movie</span>
            <h3 className="font-headline-md text-headline-md">Video Options</h3>
          </div>
          {videoOptions.length === 0 ? (
            <p className="text-label-sm text-secondary">No video formats available.</p>
          ) : (
            <div className="flex flex-col gap-3">
              {videoOptions.map((format, idx) => {
                const h = getHeight(format.resolution)
                const isStarting = startingFormat === format.formatId
                const isBest = idx === 0
                return (
                  <div
                    key={format.formatId}
                    className="flex items-center justify-between p-4 bg-surface border border-surface-variant rounded-xl hover:shadow-sm transition-shadow"
                  >
                    <div className="flex items-center gap-4 min-w-0">
                      <div
                        className={`px-3 py-1 rounded-lg font-bold text-label-sm ${
                          isBest
                            ? 'bg-primary/10 text-primary'
                            : 'bg-surface-container-high text-secondary'
                        }`}
                      >
                        {heightLabel(format.resolution)}
                      </div>
                      <div className="min-w-0">
                        <p className="font-label-md text-label-md text-on-surface truncate">
                          {qualityName(h)} • {(format.ext || 'mp4').toUpperCase()}
                        </p>
                        <p className="text-label-sm text-secondary">
                          Size: {formatFileSize(format.filesize)}
                          {format._type === 'video' ? ' • merges audio' : ''}
                        </p>
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => onDownload(format.formatId, format._type, keep)}
                      disabled={startingFormat !== null}
                      className="flex items-center gap-2 bg-primary text-on-primary px-4 py-2 rounded-lg font-label-md text-label-md active:opacity-80 transition-opacity disabled:opacity-50 disabled:cursor-not-allowed flex-shrink-0"
                    >
                      <span
                        className={`material-symbols-outlined text-[18px] ${
                          isStarting ? 'animate-spin' : ''
                        }`}
                      >
                        {isStarting ? 'progress_activity' : 'download'}
                      </span>
                      {isStarting ? 'Starting…' : 'Download'}
                    </button>
                  </div>
                )
              })}
            </div>
          )}
        </section>

        {/* Audio Only */}
        <section className="bg-surface-container-lowest border border-surface-variant rounded-xl p-6 shadow-sm space-y-4">
          <div className="flex items-center gap-2 mb-4">
            <span className="material-symbols-outlined text-primary">audiotrack</span>
            <h3 className="font-headline-md text-headline-md">Audio Only</h3>
          </div>
          {audioOptions.length === 0 ? (
            <p className="text-label-sm text-secondary">No audio formats available.</p>
          ) : (
            <div className="flex flex-col gap-3">
              {audioOptions.map((format, idx) => {
                const isStarting = startingFormat === format.formatId
                const isBest = idx === 0
                const abr = Math.round(format.abr || 0)
                return (
                  <div
                    key={format.formatId}
                    className="flex items-center justify-between p-4 bg-surface border border-surface-variant rounded-xl hover:shadow-sm transition-shadow"
                  >
                    <div className="flex items-center gap-4 min-w-0">
                      <div
                        className={`px-3 py-1 rounded-lg font-bold text-label-sm ${
                          isBest
                            ? 'bg-tertiary-container text-on-tertiary'
                            : 'bg-surface-container-high text-secondary'
                        }`}
                      >
                        {abr ? `${abr}k` : (format.ext || 'aud').toUpperCase()}
                      </div>
                      <div className="min-w-0">
                        <p className="font-label-md text-label-md text-on-surface truncate">
                          {isBest ? 'High Quality' : 'Standard'} •{' '}
                          {(format.ext || 'm4a').toUpperCase()}
                        </p>
                        <p className="text-label-sm text-secondary">
                          Size: {formatFileSize(format.filesize)}
                          {format.acodec ? ` • ${format.acodec}` : ''}
                        </p>
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => onDownload(format.formatId, 'audio', keep)}
                      disabled={startingFormat !== null}
                      className="flex items-center gap-2 border border-primary text-primary px-4 py-2 rounded-lg font-label-md text-label-md hover:bg-primary/5 active:opacity-80 transition-all disabled:opacity-50 disabled:cursor-not-allowed flex-shrink-0"
                    >
                      <span
                        className={`material-symbols-outlined text-[18px] ${
                          isStarting ? 'animate-spin' : ''
                        }`}
                      >
                        {isStarting ? 'progress_activity' : 'download'}
                      </span>
                      {isStarting ? 'Starting…' : 'Download'}
                    </button>
                  </div>
                )
              })}
              <div className="mt-4 p-4 rounded-xl bg-surface-container-low border border-dashed border-outline-variant flex items-center gap-4">
                <span className="material-symbols-outlined text-secondary">info</span>
                <p className="text-label-sm text-secondary">
                  Audio extraction may take a few moments depending on server load.
                </p>
              </div>
            </div>
          )}
        </section>
      </div>
    </div>
  )
}

export default FormatSelector
