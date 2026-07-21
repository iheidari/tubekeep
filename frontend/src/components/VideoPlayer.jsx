import { useNavigate } from 'react-router-dom'
import { useHistory } from '../context/useHistory'
import { usePlayer } from '../context/usePlayer'
import { useShareLink } from '../hooks/useShareLink'
import { fileUrl, formatFileSize, mediaKind } from '../lib/media'
import BackLink from './BackLink'
import MoveToCloud from './MoveToCloud'
import PlayerStage from './PlayerStage'

// `download.owned` is false when the record came from the public per-item
// metadata endpoint — i.e. a shared /play/:id link opened by an anonymous or
// non-owning visitor. Those visitors can watch/save/share but must not see the
// owner-only actions (they'd 404/403 server-side anyway). Absent reads as
// not-owned, so the unprivileged view is the default.
function VideoPlayer({ download, apiUrl }) {
  const owned = download.owned === true
  const navigate = useNavigate()
  const { removeDownload } = useHistory()
  const { closePlayer } = usePlayer()
  const { copied, share } = useShareLink(download.downloadId)

  const formatDate = (dateString) => {
    return new Date(dateString).toLocaleDateString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    })
  }

  const isAudio = mediaKind(download) === 'audio'
  const ext = (download.filename.match(/\.([a-z0-9]+)$/i)?.[1] || '').toUpperCase()

  const downloadUrl = fileUrl(apiUrl, download.downloadId, download.filename, { download: true })

  const handleDelete = async () => {
    if (!window.confirm('Delete this download? This cannot be undone.')) return
    closePlayer()
    await removeDownload(download.downloadId)
    navigate('/', { replace: true })
  }

  return (
    <div className="max-w-4xl mx-auto">
      <BackLink
        to={owned ? '/downloads' : '/'}
        label={owned ? 'Back to downloads' : 'Back to home'}
      />

      <div className="space-y-stack-md">
        {/* Player area — hosts the shared, persistent media element. */}
        <PlayerStage />

        {/* Metadata + actions */}
        <div>
          <div className="flex flex-col md:flex-row md:items-start justify-between gap-5">
            <div className="min-w-0">
              <h1
                className="font-bold text-[24px] leading-[1.2] tracking-[-0.02em] text-ink mb-2 break-words"
                title={download.title}
              >
                {download.title}
              </h1>
              {download.createdAt ? (
                <p className="text-muted flex items-center gap-2 text-[13px]">
                  <span className="material-symbols-outlined text-[16px]">calendar_today</span>
                  Downloaded {formatDate(download.createdAt)}
                </p>
              ) : null}
            </div>
            <div className="flex items-center gap-1.5 flex-shrink-0 flex-wrap">
              {download.size ? (
                <span className="px-2.5 py-1.5 bg-tint text-muted rounded-full font-semibold text-[11.5px]">
                  {formatFileSize(download.size)}
                </span>
              ) : null}
              {ext ? (
                <span className="px-2.5 py-1.5 bg-tint text-muted rounded-full font-semibold text-[11.5px]">
                  {ext}
                </span>
              ) : null}
              <span className="px-2.5 py-1.5 bg-tint text-muted rounded-full font-semibold text-[11.5px] uppercase">
                {isAudio ? 'Audio' : 'Video'}
              </span>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2.5 mt-6 pt-6 border-t border-line">
            <button
              type="button"
              onClick={share}
              className="flex items-center gap-2 bg-fill text-on-fill rounded-[10px] font-semibold text-[14px] hover:opacity-90 active:scale-95 transition-all py-3 px-5"
            >
              <span className="material-symbols-outlined text-[19px]">
                {copied ? 'check' : 'ios_share'}
              </span>
              {copied ? 'Link copied' : 'Share'}
            </button>

            <a
              href={downloadUrl}
              download={download.filename}
              className="flex items-center gap-2 bg-surface text-ink border border-line2 rounded-[10px] font-semibold text-[14px] hover:bg-tint active:scale-95 transition-all py-3 px-5"
            >
              <span className="material-symbols-outlined text-[19px]">download</span>
              Save file
            </a>

            {owned && !download.moved && (
              <MoveToCloud
                download={download}
                downloadHref={downloadUrl}
                onMoved={() => navigate('/downloads')}
              />
            )}

            {owned && (
              <button
                type="button"
                onClick={handleDelete}
                className="flex items-center gap-2 bg-transparent text-pop rounded-[10px] font-semibold text-[14px] hover:bg-pop/5 active:scale-95 transition-all py-3 px-4 ml-auto"
              >
                <span className="material-symbols-outlined text-[19px]">delete</span>
                Delete
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

export default VideoPlayer
