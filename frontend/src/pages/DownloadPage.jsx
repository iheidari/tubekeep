import { useEffect, useMemo, useState } from 'react'
import { useLocation, useNavigate, useParams } from 'react-router-dom'
import ProgressBar from '../components/ProgressBar'
import { useHistory } from '../context/useHistory'
import { clearStartParams, fetchDownloads, loadStartParams } from '../lib/media'

function DownloadPage() {
  const { downloadId } = useParams()
  const location = useLocation()
  const navigate = useNavigate()
  const { apiUrl, addDownload, markFailed, cancelDownload } = useHistory()

  // Start params (title/thumbnail/type + the "Keep forever" choice) come via
  // router state, recovered from sessionStorage on a reload. They're only used
  // for the local display + the failed-row fallback now — the download itself
  // runs server-side and the SSE is a pure observer, so we can attach to an
  // in-flight job (new tab / reload / cold visit) with just the downloadId.
  const stateStart = location.state?.start ? location.state : null
  const startParams = useMemo(
    () => stateStart || loadStartParams(downloadId),
    [stateStart, downloadId],
  )

  const [progress, setProgress] = useState(0)
  const [error, setError] = useState(null)

  useEffect(() => {
    // Defer side-effect setup to a microtask so React StrictMode's synchronous
    // double-mount cleanup cancels the duplicate before it runs.
    let eventSource = null
    let cancelled = false

    // Reconcile against the file list: if the download is present (and not
    // expired), adopt it and jump to the player. Used to recover when the SSE
    // reports "not found"/error but the file actually landed (job swept after
    // completion, or a transient connection drop).
    const resolveIfReady = async () => {
      const all = await fetchDownloads(apiUrl)
      if (cancelled) return false
      const found = all.find((d) => d.downloadId === downloadId && !d.expired)
      if (!found) return false
      addDownload(found)
      clearStartParams(downloadId)
      navigate(`/play/${downloadId}`, { replace: true })
      return true
    }

    const fail = (message) => {
      if (cancelled) return
      setError(message)
      // Flip the pending Downloads-list row to "Failed" so it stops spinning and
      // offers Redownload/Dismiss. Pass the known row fields (undefined without
      // start params — markFailed updates in place when the row already exists).
      markFailed(downloadId, {
        url: startParams?.url,
        type: startParams?.type,
        title: startParams?.title,
        thumbnail: startParams?.thumbnail,
      })
      clearStartParams(downloadId)
    }

    const startTimer = setTimeout(() => {
      // Pure observer: no query params — the job already owns them server-side.
      eventSource = new EventSource(`${apiUrl}/api/download/progress/${downloadId}`)

      eventSource.onmessage = async (event) => {
        const data = JSON.parse(event.data)
        if (data.type === 'ping') return
        if (data.type === 'progress') {
          setProgress(data.progress)
        } else if (data.type === 'complete') {
          setProgress(100)
          addDownload(data.data)
          clearStartParams(downloadId)
          eventSource.close()
          navigate(`/play/${downloadId}`, { replace: true })
        } else if (data.type === 'error') {
          eventSource.close()
          // The download may actually have finished (e.g. the job was swept, or
          // a stale "not found" after a completed download): reconcile against
          // the file list before declaring failure.
          try {
            if (await resolveIfReady()) return
          } catch {
            // fall through to the failure state
          }
          fail(data.error || 'Download failed')
        }
      }

      eventSource.onerror = async () => {
        eventSource.close()
        // A transient proxy blip / dropped keep-alive can fire onerror even when
        // the download finished server-side. Reconcile before declaring failure.
        try {
          if (await resolveIfReady()) return
        } catch {
          // fall through
        }
        if (!cancelled) setError((prev) => prev || 'Download connection lost')
      }
    }, 0)

    return () => {
      clearTimeout(startTimer)
      cancelled = true
      if (eventSource) eventSource.close()
    }
  }, [apiUrl, downloadId, startParams, addDownload, markFailed, navigate])

  if (error) {
    return (
      <div className="max-w-4xl mx-auto">
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

  return (
    <ProgressBar
      progress={progress}
      title={startParams?.title}
      thumbnail={startParams?.thumbnail}
      type={startParams?.type}
      onCancel={() => {
        // Actually stop the server-side job (it no longer dies on disconnect),
        // then leave the page.
        cancelDownload(downloadId)
        navigate('/', { replace: true })
      }}
    />
  )
}

export default DownloadPage
