import { useEffect, useMemo, useState } from 'react'
import { useLocation, useNavigate, useParams } from 'react-router-dom'
import ProgressBar from '../components/ProgressBar'
import { useHistory } from '../context/useHistory'
import { clearStartParams, fetchDownloads, loadStartParams } from '../lib/media'

const WATCH_POLL_MS = 2000
const WATCH_TIMEOUT_MS = 5 * 60 * 1000

function DownloadPage() {
  const { downloadId } = useParams()
  const location = useLocation()
  const navigate = useNavigate()
  const { apiUrl, addDownload, markFailed } = useHistory()

  // Start params normally arrive via router state, but a reload of /download/:id
  // wipes that — recover them from sessionStorage (per-tab, written at start)
  // so the SSE resumes and the "Keep forever" choice isn't silently dropped.
  const stateStart = location.state?.start ? location.state : null
  const startParams = useMemo(
    () => stateStart || loadStartParams(downloadId),
    [stateStart, downloadId],
  )

  const [progress, setProgress] = useState(0)
  const [error, setError] = useState(null)

  useEffect(() => {
    // Defer side-effect setup to a microtask so React StrictMode's
    // synchronous double-mount cleanup cancels the duplicate before it runs.
    // Without this, opening the EventSource on mount #1 + closing on its
    // cleanup leaves no live connection (and would also spawn yt-dlp twice).
    let eventSource = null
    let pollCancelled = false
    let pollTimer = null
    // Reconcile against the file list: if the download is present (and not
    // expired), adopt it and jump to the player. Shared by the SSE onerror
    // recovery and the no-start-params poll fallback.
    const resolveIfReady = async () => {
      const all = await fetchDownloads(apiUrl)
      if (pollCancelled) return false
      const found = all.find((d) => d.downloadId === downloadId && !d.expired)
      if (!found) return false
      addDownload(found)
      clearStartParams(downloadId)
      navigate(`/play/${downloadId}`, { replace: true })
      return true
    }
    const startTimer = setTimeout(() => {
      if (startParams) {
        const qs = new URLSearchParams({
          url: startParams.url,
          formatId: startParams.formatId,
          type: startParams.type,
          title: startParams.title || '',
          thumbnail: startParams.thumbnail || '',
          keep: startParams.keep ? 'true' : 'false',
          // Lets the backend backstop the disk-space check before spawning
          // yt-dlp; omitted/empty when the format's size is unknown.
          filesize: startParams.filesize ? String(startParams.filesize) : '',
        })

        eventSource = new EventSource(
          `${apiUrl}/api/download/progress/${downloadId}?${qs.toString()}`,
        )

        eventSource.onmessage = (event) => {
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
            setError(data.error || 'Download failed')
            // Flip the pending Downloads-list row to "Failed" so it stops
            // spinning and offers Redownload/Dismiss instead. Pass only the
            // row fields (not the whole startParams) so the fallback-insert
            // path produces the same row shape startPending writes.
            markFailed(downloadId, {
              url: startParams.url,
              type: startParams.type,
              title: startParams.title,
              thumbnail: startParams.thumbnail,
            })
            clearStartParams(downloadId)
            eventSource.close()
          }
        }

        eventSource.onerror = async () => {
          eventSource.close()
          // onerror also fires on transient proxy blips / a dropped keep-alive,
          // even when the download finished server-side. Reconcile against the
          // file list before declaring failure.
          try {
            if (await resolveIfReady()) return
          } catch {
            // fall through to the error state
          }
          if (!pollCancelled) setError('Download connection lost')
        }
      } else {
        const start = Date.now()
        const poll = async () => {
          if (pollCancelled) return
          try {
            if (await resolveIfReady()) return
            if (Date.now() - start > WATCH_TIMEOUT_MS) {
              setError('Download not found or timed out. It may have failed.')
              return
            }
          } catch (err) {
            console.error('❌ Poll error:', err)
          }
          pollTimer = setTimeout(poll, WATCH_POLL_MS)
        }
        poll()
      }
    }, 0)

    return () => {
      clearTimeout(startTimer)
      pollCancelled = true
      if (pollTimer) clearTimeout(pollTimer)
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

  if (!startParams) {
    return (
      <div className="max-w-4xl mx-auto">
        <div className="bg-surface-container-lowest border border-surface-variant rounded-xl p-12 text-center">
          <span className="material-symbols-outlined animate-spin text-[40px] text-primary mb-3 block">
            progress_activity
          </span>
          <p className="font-body-md text-body-md text-secondary">Download in progress…</p>
          <p className="font-label-sm text-label-sm text-secondary mt-2">
            Checking back every few seconds.
          </p>
        </div>
      </div>
    )
  }

  return (
    <ProgressBar
      progress={progress}
      title={startParams.title}
      thumbnail={startParams.thumbnail}
      type={startParams.type}
      onCancel={() => navigate('/', { replace: true })}
    />
  )
}

export default DownloadPage
