import { useMemo, useState } from 'react'
import { useLocation, useNavigate, useParams } from 'react-router-dom'
import ProgressBar from '../components/ProgressBar'
import { useHistory } from '../context/useHistory'
import { useDownloadProgress } from '../hooks/useDownloadProgress'
import { clearStartParams, loadStartParams } from '../lib/media'

function DownloadPage() {
  const { downloadId } = useParams()
  const location = useLocation()
  const navigate = useNavigate()
  const { markFailed, cancelDownload } = useHistory()

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

  const [error, setError] = useState(null)

  // Observe the job's SSE (shared with the Downloads-list cards). The hook owns
  // the connection + file-list reconcile; this page only supplies the terminal
  // behavior: on completion jump to the player; on a real error surface it and
  // flip the row to "failed"; on a transport blip show a soft notice (the job
  // keeps running server-side, so a reload re-attaches).
  const progress = useDownloadProgress(downloadId, {
    onComplete: () => {
      clearStartParams(downloadId)
      navigate(`/play/${downloadId}`, { replace: true })
    },
    onError: (message) => {
      setError(message || 'Download failed')
      markFailed(downloadId, {
        url: startParams?.url,
        type: startParams?.type,
        title: startParams?.title,
        thumbnail: startParams?.thumbnail,
      })
      clearStartParams(downloadId)
    },
    onTransportError: () => setError((prev) => prev || 'Download connection lost'),
  })

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
