import { useEffect, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import BackLink from '../components/BackLink'
import MoveToCloud from '../components/MoveToCloud'
import VideoPlayer from '../components/VideoPlayer'
import { useHistory } from '../context/useHistory'
import { usePlayer } from '../context/usePlayer'
import { fetchDownloads, fileUrl } from '../lib/media'

function PlayPageContent({ downloadId }) {
  const { history, apiUrl, findById } = useHistory()
  const { playTrack } = usePlayer()
  const navigate = useNavigate()
  const [coldResult, setColdResult] = useState({ status: 'pending', data: null })

  const fromContext = history.find((d) => d.downloadId === downloadId) || null

  useEffect(() => {
    if (fromContext) return
    let cancelled = false

    fetchDownloads(apiUrl)
      .then((all) => {
        if (cancelled) return
        const found = all.find((d) => d.downloadId === downloadId)
        if (found && !found.expired) {
          setColdResult({
            status: 'found',
            data: {
              ...found,
              fileUrl: fileUrl(apiUrl, found.downloadId, found.filename),
            },
          })
          return
        }
        if (found?.expired) {
          setColdResult({ status: 'missing', data: found })
          return
        }
        setColdResult({ status: 'missing', data: findById(downloadId) })
      })
      .catch(() => {
        if (!cancelled) {
          setColdResult({ status: 'missing', data: findById(downloadId) })
        }
      })

    return () => {
      cancelled = true
    }
  }, [downloadId, fromContext, apiUrl, findById])

  const resolved = fromContext || (coldResult.status === 'found' ? coldResult.data : null)
  const missing = !fromContext && coldResult.status === 'missing'

  useEffect(() => {
    if (resolved) playTrack(resolved, apiUrl)
  }, [resolved, apiUrl, playTrack])

  const backLink = <BackLink />

  if (missing) {
    const stale = coldResult.data
    return (
      <div className="max-w-4xl mx-auto">
        {backLink}
        <div className="bg-surface-container-lowest border border-surface-variant rounded-xl p-12 text-center">
          <span className="material-symbols-outlined text-[48px] text-secondary mb-3 block">
            schedule
          </span>
          <h2 className="font-headline-md text-headline-md text-on-surface mb-2">File not found</h2>
          <p className="font-body-md text-body-md text-secondary mb-6">
            This download may have expired (files are removed from our server after 1 hour) or been
            moved to a cloud account.
          </p>
          <div className="flex items-center gap-3 justify-center flex-wrap">
            {stale?.url && (
              <Link
                to={`/info?url=${encodeURIComponent(stale.url)}`}
                className="bg-primary text-on-primary px-4 py-2 rounded-lg font-label-md text-label-md hover:bg-primary-container transition-colors inline-flex items-center gap-2"
              >
                <span className="material-symbols-outlined text-[18px]">refresh</span>
                Re-download
              </Link>
            )}
            <Link
              to="/"
              className="border border-outline-variant text-on-surface-variant px-4 py-2 rounded-lg font-label-md text-label-md hover:bg-surface-container-high transition-colors inline-flex items-center gap-2"
            >
              Back to home
            </Link>
          </div>
        </div>
      </div>
    )
  }

  if (!resolved) {
    return (
      <div className="max-w-4xl mx-auto">
        {backLink}
        <div className="bg-surface-container-lowest border border-surface-variant rounded-xl p-12 text-center">
          <span className="material-symbols-outlined animate-spin text-[40px] text-primary mb-3 block">
            progress_activity
          </span>
          <p className="font-body-md text-body-md text-secondary">Loading…</p>
        </div>
      </div>
    )
  }

  return (
    <>
      <VideoPlayer download={resolved} apiUrl={apiUrl} />
      {!resolved.moved && (
        <div className="max-w-4xl mx-auto mt-4 flex justify-end">
          <MoveToCloud
            download={resolved}
            downloadHref={fileUrl(apiUrl, resolved.downloadId, resolved.filename, {
              download: true,
            })}
            onMoved={() => navigate('/downloads')}
          />
        </div>
      )}
    </>
  )
}

function PlayPage() {
  const { downloadId } = useParams()
  return <PlayPageContent key={downloadId} downloadId={downloadId} />
}

export default PlayPage
