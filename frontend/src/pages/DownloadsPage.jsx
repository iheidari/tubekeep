import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import MoveToCloud from '../components/MoveToCloud'
import { useHistory } from '../context/useHistory'
import { useShareLink } from '../hooks/useShareLink'
import { fileUrl, formatFileSize, mediaKind } from '../lib/media'

const FILTERS = [
  { id: 'all', label: 'All' },
  { id: 'video', label: 'Videos' },
  { id: 'audio', label: 'Audio' },
]

function formatRelative(dateString) {
  if (!dateString) return ''
  const diff = Math.max(0, Date.now() - new Date(dateString).getTime())
  const minutes = Math.floor(diff / 60000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`
  const days = Math.floor(hours / 24)
  if (days < 7) return `${days} day${days === 1 ? '' : 's'} ago`
  const weeks = Math.floor(days / 7)
  if (weeks < 5) return `${weeks} week${weeks === 1 ? '' : 's'} ago`
  const months = Math.floor(days / 30)
  if (months < 12) return `${months} month${months === 1 ? '' : 's'} ago`
  const years = Math.floor(days / 365)
  return `${years} year${years === 1 ? '' : 's'} ago`
}

function ActiveCard({ download, apiUrl, onDelete, onKeep }) {
  const { copied, share } = useShareLink(download.downloadId)
  const isAudio = mediaKind(download) === 'audio'

  const downloadHref = fileUrl(apiUrl, download.downloadId, download.filename, { download: true })

  return (
    <div className="group bg-surface-container-lowest border border-surface-variant rounded-lg p-4 flex flex-col sm:flex-row gap-4 hover:shadow-md transition-shadow">
      <Link
        to={`/play/${download.downloadId}`}
        className="relative w-full sm:w-48 aspect-video flex-shrink-0 overflow-hidden rounded-md block bg-surface-container-high"
      >
        {download.thumbnail ? (
          <img
            src={download.thumbnail}
            alt={download.title}
            className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-500"
          />
        ) : (
          <div className="w-full h-full flex items-center justify-center">
            <span className="material-symbols-outlined text-on-surface-variant text-[40px]">
              {isAudio ? 'music_note' : 'movie'}
            </span>
          </div>
        )}
        <div className="absolute bottom-2 right-2 bg-black/70 text-white text-[10px] px-1.5 py-0.5 rounded font-bold uppercase tracking-wide">
          {isAudio ? 'Audio' : 'Video'}
        </div>
      </Link>

      <div className="flex-grow flex flex-col justify-between min-w-0">
        <div>
          <div className="flex justify-between items-start gap-2">
            <h3 className="font-headline-md text-headline-md text-on-surface truncate pr-4">
              {download.title}
            </h3>
            <div className="flex items-center gap-2 flex-shrink-0">
              <button
                type="button"
                onClick={() => onKeep(download.downloadId, !download.kept)}
                title={
                  download.kept ? 'Kept — click to let it expire' : 'Keep this file from expiring'
                }
                className={
                  download.kept
                    ? 'flex items-center gap-1 text-on-primary font-label-sm text-label-sm whitespace-nowrap bg-primary px-2 py-0.5 rounded-full transition-colors active:scale-95'
                    : 'flex items-center gap-1 text-primary font-label-sm text-label-sm whitespace-nowrap border border-primary px-2 py-0.5 rounded-full hover:bg-primary/5 transition-colors active:scale-95'
                }
              >
                <span
                  className="material-symbols-outlined text-[14px]"
                  style={download.kept ? { fontVariationSettings: "'FILL' 1" } : undefined}
                >
                  push_pin
                </span>
                {download.kept ? 'Kept' : 'Keep'}
              </button>
              <span className="flex items-center gap-1 text-tertiary font-label-sm text-label-sm whitespace-nowrap bg-tertiary-fixed px-2 py-0.5 rounded-full">
                <span
                  className="material-symbols-outlined text-[14px]"
                  style={{ fontVariationSettings: "'FILL' 1" }}
                >
                  check_circle
                </span>
                Completed
              </span>
            </div>
          </div>
          {download.url && (
            <a
              href={download.url}
              target="_blank"
              rel="noopener noreferrer"
              className="font-label-sm text-label-sm text-on-surface-variant hover:text-primary mt-1 truncate block"
            >
              {download.url}
            </a>
          )}
          <div className="flex flex-wrap items-center gap-3 mt-3">
            <span className="bg-surface-variant text-on-surface-variant px-2 py-0.5 rounded font-label-sm text-label-sm">
              {isAudio ? 'Audio' : 'Video'}
            </span>
            <span className="text-on-surface-variant/60 font-label-sm text-label-sm">
              {formatFileSize(download.size)}
            </span>
            <span className="text-on-surface-variant/60 font-label-sm text-label-sm">
              • Downloaded {formatRelative(download.createdAt)}
            </span>
          </div>
        </div>

        <div className="flex items-center justify-between mt-4">
          <Link
            to={`/play/${download.downloadId}`}
            className="bg-primary text-on-primary px-6 py-2 rounded-md font-label-md text-label-md flex items-center gap-2 hover:opacity-90 active:scale-95 transition-all"
          >
            <span
              className="material-symbols-outlined text-[18px]"
              style={{ fontVariationSettings: "'FILL' 1" }}
            >
              {isAudio ? 'headphones' : 'play_arrow'}
            </span>
            {isAudio ? 'Listen' : 'Play Now'}
          </Link>
          <div className="flex items-center gap-3">
            <MoveToCloud download={download} downloadHref={downloadHref} />
            <div className="flex items-center gap-1">
              <button
                type="button"
                onClick={share}
                className="p-2 text-on-surface-variant hover:text-primary hover:bg-surface-container-high transition-all rounded-full"
                title={copied ? 'Copied!' : 'Share play link'}
              >
                <span className="material-symbols-outlined">{copied ? 'check' : 'share'}</span>
              </button>
              <a
                href={downloadHref}
                download={download.filename}
                className="p-2 text-on-surface-variant hover:text-primary hover:bg-surface-container-high transition-all rounded-full"
                title="Download file"
              >
                <span className="material-symbols-outlined">download</span>
              </a>
              <button
                type="button"
                onClick={() => onDelete(download.downloadId)}
                className="p-2 text-on-surface-variant hover:text-error hover:bg-error-container/20 transition-all rounded-full"
                title="Delete"
              >
                <span className="material-symbols-outlined">delete</span>
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

function ExpiredCard({ download, onForget }) {
  const isAudio = mediaKind(download) === 'audio'

  return (
    <div className="group bg-surface-container-low/50 border border-surface-variant/50 rounded-lg p-4 flex flex-col sm:flex-row gap-4 opacity-75 hover:opacity-100 transition-opacity">
      <div className="relative w-full sm:w-48 aspect-video flex-shrink-0 overflow-hidden rounded-md grayscale group-hover:grayscale-0 transition-all duration-500 bg-surface-container-high">
        {download.thumbnail ? (
          <img
            src={download.thumbnail}
            alt={download.title}
            className="w-full h-full object-cover"
          />
        ) : (
          <div className="w-full h-full flex items-center justify-center">
            <span className="material-symbols-outlined text-on-surface-variant/50 text-[40px]">
              {isAudio ? 'music_note' : 'movie'}
            </span>
          </div>
        )}
        <div className="absolute inset-0 bg-background/40 flex items-center justify-center">
          <span className="material-symbols-outlined text-white text-[40px]">history</span>
        </div>
      </div>

      <div className="flex-grow flex flex-col justify-between min-w-0">
        <div>
          <div className="flex justify-between items-start gap-2">
            <h3 className="font-headline-md text-headline-md text-on-surface/60 truncate pr-4">
              {download.title}
            </h3>
            <span className="flex items-center gap-1 text-on-error-container font-label-sm text-label-sm whitespace-nowrap bg-error-container px-2 py-0.5 rounded-full">
              <span className="material-symbols-outlined text-[14px]">error_outline</span>
              Expired
            </span>
          </div>
          {download.url && (
            <p className="font-label-sm text-label-sm text-on-surface-variant/60 mt-1 truncate">
              {download.url}
            </p>
          )}
          <div className="flex flex-wrap items-center gap-3 mt-3">
            <span className="bg-surface-variant/50 text-on-surface-variant/50 px-2 py-0.5 rounded font-label-sm text-label-sm">
              {isAudio ? 'Audio' : 'Video'}
            </span>
            <span className="text-on-surface-variant/40 font-label-sm text-label-sm">
              {formatFileSize(download.size)}
            </span>
            <span className="text-on-surface-variant/40 font-label-sm text-label-sm">
              • Downloaded {formatRelative(download.createdAt)}
            </span>
          </div>
        </div>

        <div className="flex items-center justify-between mt-4">
          {download.url ? (
            <Link
              to={`/info?url=${encodeURIComponent(download.url)}`}
              className="border border-primary text-primary px-6 py-2 rounded-md font-label-md text-label-md flex items-center gap-2 hover:bg-primary/5 transition-all active:scale-95"
            >
              <span className="material-symbols-outlined text-[18px]">refresh</span>
              Redownload
            </Link>
          ) : (
            <span className="text-on-surface-variant/40 font-label-sm text-label-sm">
              No source URL
            </span>
          )}
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => onForget(download.downloadId)}
              className="p-2 text-on-surface-variant hover:text-error hover:bg-error-container/20 transition-all rounded-full"
              title="Forget"
            >
              <span className="material-symbols-outlined">delete</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

function MovedCard({ download, onForget }) {
  const isAudio = mediaKind(download) === 'audio'
  const link = download.moved?.link

  return (
    <div className="group bg-surface-container-lowest border border-surface-variant rounded-lg p-4 flex flex-col sm:flex-row gap-4">
      <div className="relative w-full sm:w-48 aspect-video flex-shrink-0 overflow-hidden rounded-md bg-surface-container-high">
        {download.thumbnail ? (
          <img
            src={download.thumbnail}
            alt={download.title}
            className="w-full h-full object-cover"
          />
        ) : (
          <div className="w-full h-full flex items-center justify-center">
            <span className="material-symbols-outlined text-on-surface-variant text-[40px]">
              {isAudio ? 'music_note' : 'movie'}
            </span>
          </div>
        )}
        <div className="absolute inset-0 bg-background/30 flex items-center justify-center">
          <span className="material-symbols-outlined text-white text-[40px]">cloud_done</span>
        </div>
      </div>

      <div className="flex-grow flex flex-col justify-between min-w-0">
        <div>
          <div className="flex justify-between items-start gap-2">
            <h3 className="font-headline-md text-headline-md text-on-surface truncate pr-4">
              {download.title}
            </h3>
            <span className="flex items-center gap-1 text-tertiary font-label-sm text-label-sm whitespace-nowrap bg-tertiary-fixed px-2 py-0.5 rounded-full">
              <span
                className="material-symbols-outlined text-[14px]"
                style={{ fontVariationSettings: "'FILL' 1" }}
              >
                cloud_done
              </span>
              Moved to Dropbox
            </span>
          </div>
          <p className="font-label-sm text-label-sm text-on-surface-variant mt-1">
            This file is now in your Dropbox and has been removed from our server.
          </p>
        </div>

        <div className="flex items-center justify-between mt-4">
          {link ? (
            <a
              href={link}
              target="_blank"
              rel="noopener noreferrer"
              className="bg-primary text-on-primary px-6 py-2 rounded-md font-label-md text-label-md flex items-center gap-2 hover:opacity-90 active:scale-95 transition-all"
            >
              <span className="material-symbols-outlined text-[18px]">open_in_new</span>
              Open in Dropbox
            </a>
          ) : (
            <span className="text-on-surface-variant/60 font-label-sm text-label-sm">
              Saved to Dropbox
            </span>
          )}
          <button
            type="button"
            onClick={() => onForget(download.downloadId)}
            className="p-2 text-on-surface-variant hover:text-error hover:bg-error-container/20 transition-all rounded-full"
            title="Remove from list"
          >
            <span className="material-symbols-outlined">delete</span>
          </button>
        </div>
      </div>
    </div>
  )
}

function DownloadsPage() {
  const { history, expired, apiUrl, removeDownload, forgetExpired, setKept, dropLocal } =
    useHistory()
  const [filter, setFilter] = useState('all')

  const items = useMemo(() => {
    const merged = [
      ...history.map((d) => ({ ...d, _expired: false })),
      ...expired.map((d) => ({ ...d, _expired: true })),
    ]
    const filtered = filter === 'all' ? merged : merged.filter((d) => mediaKind(d) === filter)
    return filtered.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
  }, [history, expired, filter])

  return (
    <>
      <div className="flex flex-col md:flex-row md:items-end justify-between gap-stack-sm mb-stack-md">
        <div>
          <h2 className="font-headline-lg text-headline-lg text-on-surface mb-2">My Downloads</h2>
          <p className="font-body-md text-body-md text-on-surface-variant">
            Manage your saved media. Move a file to your Dropbox to keep it, or download it to your
            device. Files expire from our server after 1 hour and can be re-downloaded from the
            source.
          </p>
        </div>
        <div className="flex items-center gap-2 bg-surface-container-low p-1 rounded-lg">
          {FILTERS.map((f) => (
            <button
              type="button"
              key={f.id}
              onClick={() => setFilter(f.id)}
              className={
                filter === f.id
                  ? 'px-4 py-2 rounded-md bg-surface text-primary shadow-sm font-label-md text-label-md'
                  : 'px-4 py-2 rounded-md text-on-surface-variant hover:bg-surface-container-high transition-colors font-label-md text-label-md'
              }
            >
              {f.label}
            </button>
          ))}
        </div>
      </div>

      {items.length === 0 ? (
        <div className="bg-surface-container-low border border-outline-variant rounded-xl p-12 text-center">
          <span className="material-symbols-outlined text-[48px] text-outline-variant mb-3 block">
            cloud_download
          </span>
          <p className="font-body-md text-body-md text-secondary">
            No downloads yet.{' '}
            <Link to="/" className="text-primary hover:underline">
              Paste a URL on the home page
            </Link>{' '}
            to get started.
          </p>
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          {items.map((item) => {
            if (item.moved) {
              return <MovedCard key={item.downloadId} download={item} onForget={dropLocal} />
            }
            return item._expired ? (
              <ExpiredCard key={item.downloadId} download={item} onForget={forgetExpired} />
            ) : (
              <ActiveCard
                key={item.downloadId}
                download={item}
                apiUrl={apiUrl}
                onDelete={removeDownload}
                onKeep={setKept}
              />
            )
          })}
        </div>
      )}
    </>
  )
}

export default DownloadsPage
