import { useEffect, useMemo, useState } from 'react'
import { Link, Navigate, useNavigate, useSearchParams } from 'react-router-dom'
import BackLink from '../components/BackLink'
import FormatSelector from '../components/FormatSelector'
import { useHistory } from '../context/useHistory'
import { providerLabel } from '../lib/cloud'
import { apiFetch, fetchDisk, saveStartParams, sharesSource } from '../lib/media'

// The one row a download of `info` would be duplicating, or null. Only the three
// states where downloading again is genuinely redundant count, most actionable
// first: a job already running for this video, a copy whose media is still on
// our disk, and a copy the user has moved to their own cloud. Expired rows are
// deliberately NOT a duplicate — their media is gone, so re-downloading one is
// the intended action, not a mistake. Failed rows are excluded for the same
// reason. Matching is `sharesSource`, so a video pasted as a different link form
// (youtu.be/ID vs watch?v=ID) is still recognised (0XC-117).
//
// `filename` is the "media landed" signal rather than `status === 'complete'`
// because this list holds two shapes: rows synced from GET /api/files carry a
// status, while the record addDownload writes from the SSE `complete` payload
// does not — both carry a filename.
function findDuplicate(info, history) {
  if (!info) return null
  const fresh = { url: info.originalUrl, sourceKey: info.sourceKey }
  const matches = history.filter((d) => sharesSource(fresh, d))
  return (
    matches.find((d) => d.status === 'downloading') ||
    matches.find((d) => !!d.filename && !d.expired && !d.moved && d.status !== 'failed') ||
    matches.find((d) => d.moved) ||
    null
  )
}

// Copy for each duplicate state. The consequence line matters more than the
// headline: the server supersedes an older row for the same video once the new
// download completes (0XC-10), so "you already have this" really means "this
// will replace it" — except for a moved row, which supersede spares.
function duplicateNotice(duplicate) {
  if (duplicate.status === 'downloading') {
    return {
      icon: 'downloading',
      headline: 'This video is already downloading.',
      detail: 'Starting it again runs a second download of the same video.',
      action: { to: `/download/${duplicate.downloadId}`, label: 'View progress' },
    }
  }
  if (duplicate.moved) {
    const label = providerLabel(duplicate.moved.provider)
    return {
      icon: 'cloud_done',
      headline: `You already moved this video to your ${label}.`,
      detail: `Downloading it again won't touch the copy in your ${label}.`,
      action: duplicate.moved.link
        ? { href: duplicate.moved.link, label: `Open in ${label}` }
        : null,
    }
  }
  return {
    icon: 'check_circle',
    headline: 'You already have this video.',
    detail: 'Downloading it again replaces the copy in your downloads.',
    action: { to: `/play/${duplicate.downloadId}`, label: 'Play it' },
  }
}

// Non-blocking on purpose: re-downloading is legitimate (a different format or
// quality, or simply wanting a fresh copy), so this informs rather than stops.
// `role="status"` over `alert` for the same reason — it resolves after the info
// fetch, and a polite announcement shouldn't interrupt what a screen reader is
// already reading out about the formats below.
function DuplicateBanner({ duplicate }) {
  const { icon, headline, detail, action } = duplicateNotice(duplicate)

  return (
    <div className="max-w-4xl mx-auto mb-stack-sm">
      <div
        role="status"
        className="flex items-start gap-3 bg-surface border border-line rounded-xl px-4 py-3.5"
      >
        <span className="material-symbols-outlined text-pop text-[20px]" aria-hidden="true">
          {icon}
        </span>
        <div className="flex-1 min-w-0">
          <p className="font-semibold text-[13.5px] text-ink">{headline}</p>
          <p className="text-[12.5px] text-muted mt-0.5">{detail}</p>
        </div>
        {action &&
          (action.href ? (
            <a
              href={action.href}
              target="_blank"
              rel="noopener noreferrer"
              className="flex-shrink-0 text-[12.5px] font-semibold text-pop hover:underline whitespace-nowrap"
            >
              {action.label}
            </a>
          ) : (
            <Link
              to={action.to}
              className="flex-shrink-0 text-[12.5px] font-semibold text-pop hover:underline whitespace-nowrap"
            >
              {action.label}
            </Link>
          ))}
      </div>
    </div>
  )
}

function InfoPage() {
  const [searchParams] = useSearchParams()
  const navigate = useNavigate()
  const { apiUrl, history, startPending } = useHistory()
  const url = searchParams.get('url')

  const [info, setInfo] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  // Non-fatal error surfaced when starting a download fails (e.g. the server is
  // at its concurrency cap → HTTP 429). Shown as a dismissable inline banner
  // above the format list so the user can retry, unlike `error` which replaces
  // the whole page for a failed info fetch.
  const [startError, setStartError] = useState(null)
  const [startingFormat, setStartingFormat] = useState(null)
  const [disk, setDisk] = useState(null)

  // Server disk usage powers the banner + the oversized-format disable check.
  // Fetched independently of the slow yt-dlp info call so the format list isn't
  // held up; a null result just hides the banner and blocks nothing.
  useEffect(() => {
    let cancelled = false
    fetchDisk(apiUrl).then((d) => {
      if (!cancelled) setDisk(d)
    })
    return () => {
      cancelled = true
    }
  }, [apiUrl])

  useEffect(() => {
    if (!url) return
    let cancelled = false
    setLoading(true)
    setError(null)
    setInfo(null)

    apiFetch(`${apiUrl}/api/info?url=${encodeURIComponent(url)}`)
      .then((r) => r.json())
      .then((data) => {
        if (cancelled) return
        if (!data.success) throw new Error(data.error)
        setInfo({ ...data.data, originalUrl: url })
      })
      .catch((err) => {
        if (cancelled) return
        setError(err.message || 'Failed to fetch video info')
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [url, apiUrl])

  // Recomputed as the history list changes, so the banner appears the moment a
  // concurrent download of the same video starts in another tab and clears
  // itself if that row is cancelled while this screen is open.
  const duplicate = useMemo(() => findDuplicate(info, history), [info, history])

  if (!url) return <Navigate to="/" replace />

  const handleDownload = async (formatId, type, keep, filesize) => {
    setStartingFormat(formatId)
    setError(null)
    setStartError(null)
    try {
      // POST now starts the job server-side, so it carries every parameter the
      // backend needs to run + persist the download (the SSE is a pure observer
      // and no longer receives them on its query string). `filesize` lets the
      // backend backstop the disk-space check before starting the job.
      const response = await apiFetch(`${apiUrl}/api/download`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url: info.originalUrl,
          formatId,
          type,
          title: info.title,
          thumbnail: info.thumbnail,
          keep,
          filesize,
          // Namespaced extractor id from /api/info — lets the server match a
          // re-download by canonical video identity instead of the raw URL
          // string (0XC-117).
          sourceKey: info.sourceKey,
        }),
      })
      const data = await response.json()
      if (!data.success) throw new Error(data.error)

      const { downloadId } = data.data
      const startState = {
        start: true,
        url: info.originalUrl,
        formatId,
        type,
        title: info.title,
        thumbnail: info.thumbnail,
        keep,
      }
      // Persist per-tab so a reload of the download page can resume the SSE
      // (and keep the "Keep forever" choice) instead of losing router state.
      saveStartParams(downloadId, startState)
      // Write a "Downloading…" row now so the file is findable in the Downloads
      // list even if the user navigates away before the SSE completes. It
      // upgrades in place to a completed card on completion (or "Failed" on error).
      startPending({
        downloadId,
        url: info.originalUrl,
        // Carried so this placeholder is matchable by canonical identity before
        // the next server sync replaces it — without it the duplicate warning
        // would miss an in-flight download pasted as a different link form.
        sourceKey: info.sourceKey,
        type,
        title: info.title,
        thumbnail: info.thumbnail,
        createdAt: new Date().toISOString(),
      })
      navigate(`/download/${downloadId}`, { replace: true, state: startState })
    } catch (err) {
      // Keep the format list up (unlike the fatal info-fetch `error`) so the
      // user can retry — the common case is a transient 429 "server busy".
      setStartError(err.message || 'Failed to start download')
      setStartingFormat(null)
    }
  }

  const backLink = <BackLink />

  if (loading) {
    return (
      <div className="max-w-4xl mx-auto">
        {backLink}
        <div className="bg-surface-container-lowest border border-surface-variant rounded-xl p-12 text-center">
          <span
            className="material-symbols-outlined animate-spin text-[40px] text-primary mb-3 block"
            aria-hidden="true"
          >
            progress_activity
          </span>
          <p className="font-body-md text-body-md text-secondary">Fetching video info…</p>
        </div>
      </div>
    )
  }

  if (error) {
    return (
      <div className="max-w-4xl mx-auto">
        {backLink}
        <div className="bg-error-container border border-error rounded-xl p-6 text-center">
          <span
            className="material-symbols-outlined text-[40px] text-error mb-2 block"
            aria-hidden="true"
          >
            error
          </span>
          <p className="font-body-md text-body-md text-on-error-container mb-4">{error}</p>
          <button
            type="button"
            onClick={() => navigate('/')}
            className="bg-primary text-on-primary px-4 py-2 rounded-lg font-label-md text-label-md hover:bg-primary-container transition-colors"
          >
            Back to home
          </button>
        </div>
      </div>
    )
  }

  if (!info) return null

  return (
    <>
      {startError && (
        <div className="max-w-4xl mx-auto mb-stack-sm">
          <div
            role="alert"
            className="flex items-start gap-3 bg-error-container border border-error/40 rounded-xl px-4 py-3"
          >
            <span className="material-symbols-outlined text-error text-[20px]" aria-hidden="true">
              error
            </span>
            <p className="flex-1 font-body-md text-body-md text-on-error-container">{startError}</p>
            <button
              type="button"
              onClick={() => setStartError(null)}
              className="p-1 text-on-error-container/70 hover:text-on-error-container rounded-full transition-colors"
              aria-label="Dismiss error"
            >
              <span className="material-symbols-outlined text-[18px]" aria-hidden="true">
                close
              </span>
            </button>
          </div>
        </div>
      )}
      {duplicate && <DuplicateBanner duplicate={duplicate} />}
      <FormatSelector
        info={info}
        onDownload={handleDownload}
        startingFormat={startingFormat}
        disk={disk}
      />
    </>
  )
}

export default InfoPage
