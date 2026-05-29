import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useHistory } from '../context/useHistory'
import { usePlayer } from '../context/usePlayer'
import PlayerStage from './PlayerStage'

function VideoPlayer({ download, apiUrl }) {
  const navigate = useNavigate()
  const { removeDownload } = useHistory()
  const { closePlayer } = usePlayer()
  const [copied, setCopied] = useState(false)

  const formatFileSize = (bytes) => {
    if (!bytes) return 'Unknown'
    const sizes = ['B', 'KB', 'MB', 'GB']
    const i = Math.floor(Math.log(bytes) / Math.log(1024))
    return `${(bytes / Math.pow(1024, i)).toFixed(2)} ${sizes[i]}`
  }

  const formatDate = (dateString) => {
    return new Date(dateString).toLocaleDateString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric'
    })
  }

  const isAudio = /\.(mp3|m4a|ogg|opus|wav|flac)$/i.test(download.filename)
  const ext = (download.filename.match(/\.([a-z0-9]+)$/i)?.[1] || '').toUpperCase()

  const encodedFilename = encodeURIComponent(download.filename)
  const downloadUrl = `${apiUrl}/api/files/${download.downloadId}/${encodedFilename}?action=download`

  const handleShare = async () => {
    const shareUrl = `${window.location.origin}/play/${download.downloadId}`
    try {
      await navigator.clipboard.writeText(shareUrl)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch (err) {
      console.error('❌ Share copy failed:', err)
    }
  }

  const handleDelete = async () => {
    if (!window.confirm('Delete this download? This cannot be undone.')) return
    closePlayer()
    await removeDownload(download.downloadId)
    navigate('/', { replace: true })
  }

  return (
    <div className="max-w-4xl mx-auto">
      <Link
        to="/"
        className="inline-flex items-center gap-1 text-secondary hover:text-primary font-label-md text-label-md mb-stack-md transition-colors"
      >
        <span className="material-symbols-outlined text-[20px]">arrow_back</span>
        Back
      </Link>

      <div className="space-y-stack-md">
        {/* Player area — hosts the shared, persistent media element. */}
        <PlayerStage />

        {/* Metadata + actions */}
        <div className="bg-surface p-6 rounded-xl border border-surface-variant">
          <div className="flex flex-col md:flex-row md:items-start justify-between gap-4 mb-6">
            <div className="min-w-0">
              <h1 className="font-headline-lg text-headline-lg mb-2 break-words" title={download.title}>
                {download.title}
              </h1>
              <p className="text-on-surface-variant flex items-center gap-2 font-body-md text-body-md">
                <span className="material-symbols-outlined text-[18px]">calendar_today</span>
                Downloaded on {formatDate(download.createdAt)}
              </p>
            </div>
            <div className="flex items-center gap-2 flex-shrink-0 flex-wrap">
              <span className="px-3 py-1 bg-surface-container-high rounded-full font-label-sm text-label-sm">
                {formatFileSize(download.size)}
              </span>
              {ext ? (
                <span className="px-3 py-1 bg-surface-container-high rounded-full font-label-sm text-label-sm">
                  {ext}
                </span>
              ) : null}
              <span className="px-3 py-1 bg-surface-container-high rounded-full font-label-sm text-label-sm uppercase">
                {isAudio ? 'Audio' : 'Video'}
              </span>
            </div>
          </div>

          <div className="grid gap-4 border-t border-surface-variant pt-6 grid-cols-[repeat(auto-fit,minmax(140px,1fr))]">
            <button
              onClick={handleShare}
              className="flex items-center justify-center gap-2 bg-primary text-on-primary rounded-lg font-label-md text-label-md hover:bg-primary-container transition-colors active:scale-95 py-4 px-4"
            >
              <span className="material-symbols-outlined">{copied ? 'check' : 'share'}</span>
              {copied ? 'Link copied' : 'Share'}
            </button>

            {download.url ? (
              <Link
                to={`/info?url=${encodeURIComponent(download.url)}`}
                className="flex items-center justify-center gap-2 bg-secondary-container text-on-secondary-container border border-outline-variant rounded-lg font-label-md text-label-md hover:bg-surface-container-high transition-colors active:scale-95 py-4 px-4"
              >
                <span className="material-symbols-outlined">refresh</span>
                Redownload
              </Link>
            ) : (
              <a
                href={downloadUrl}
                download={download.filename}
                className="flex items-center justify-center gap-2 bg-secondary-container text-on-secondary-container border border-outline-variant rounded-lg font-label-md text-label-md hover:bg-surface-container-high transition-colors active:scale-95 py-4 px-4"
              >
                <span className="material-symbols-outlined">download</span>
                Save file
              </a>
            )}

            {download.url ? (
              <a
                href={download.url}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center justify-center gap-2 border border-outline-variant text-on-surface-variant rounded-lg font-label-md text-label-md hover:bg-surface-container-high transition-colors active:scale-95 py-4 px-4"
              >
                <span className="material-symbols-outlined">open_in_new</span>
                View source
              </a>
            ) : null}

            <button
              onClick={handleDelete}
              className="flex items-center justify-center gap-2 border border-error/30 text-error rounded-lg font-label-md text-label-md hover:bg-error-container/50 transition-colors active:scale-95 py-4 px-4"
            >
              <span className="material-symbols-outlined">delete</span>
              Delete
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

export default VideoPlayer
