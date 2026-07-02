import { useEffect, useState } from 'react'
import { useLocation, useNavigate, useParams } from 'react-router-dom'
import ProgressBar from '../components/ProgressBar'
import { useHistory } from '../context/useHistory'

const WATCH_POLL_MS = 2000
const WATCH_TIMEOUT_MS = 5 * 60 * 1000

function DownloadPage() {
  const { downloadId } = useParams()
  const location = useLocation()
  const navigate = useNavigate()
  const { apiUrl, addDownload } = useHistory()

  const startParams = location.state?.start ? location.state : null
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
    const startTimer = setTimeout(() => {
      if (startParams) {
        const qs = new URLSearchParams({
          url: startParams.url,
          formatId: startParams.formatId,
          type: startParams.type,
          title: startParams.title || '',
          thumbnail: startParams.thumbnail || '',
          keep: startParams.keep ? 'true' : 'false',
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
            eventSource.close()
            navigate(`/play/${downloadId}`, { replace: true })
          } else if (data.type === 'error') {
            setError(data.error || 'Download failed')
            eventSource.close()
          }
        }

        eventSource.onerror = () => {
          eventSource.close()
          setError('Download connection lost')
        }
      } else {
        const start = Date.now()
        const poll = async () => {
          if (pollCancelled) return
          try {
            const response = await fetch(`${apiUrl}/api/files`)
            const data = await response.json()
            if (pollCancelled) return
            if (data.success && Array.isArray(data.data)) {
              const found = data.data.find((d) => d.downloadId === downloadId && !d.expired)
              if (found) {
                addDownload(found)
                navigate(`/play/${downloadId}`, { replace: true })
                return
              }
            }
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
  }, [apiUrl, downloadId, startParams, addDownload, navigate])

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

  return <ProgressBar progress={progress} />
}

export default DownloadPage
