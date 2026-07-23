import { useEffect, useState } from 'react'
import { Navigate, useNavigate, useSearchParams } from 'react-router-dom'
import BackLink from '../components/BackLink'
import FormatSelector from '../components/FormatSelector'
import { useHistory } from '../context/useHistory'
import { apiFetch, fetchDisk, saveStartParams } from '../lib/media'

function InfoPage() {
  const [searchParams] = useSearchParams()
  const navigate = useNavigate()
  const { apiUrl, startPending } = useHistory()
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
          captions: info.captions,
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
          <span className="material-symbols-outlined animate-spin text-[40px] text-primary mb-3 block">
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
          <span className="material-symbols-outlined text-[40px] text-error mb-2 block">error</span>
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
