import { useEffect, useState } from 'react'
import { useHistory } from '../context/useHistory'
import { fetchDownloads } from '../lib/media'

// Live progress for a still-running Downloads-list row. Attaches to the job's
// observer SSE (a pure observer — no extra yt-dlp process, and the DownloadPage
// can watch the same job concurrently), returning 0–100. On completion it
// upgrades the row in place via addDownload; on a terminal error it flips the
// row to 'failed' via markFailed (after reconciling against the file list, in
// case the job just finished and was swept). A transient transport blip is left
// to EventSource's native auto-reconnect, so the row keeps updating.
export function useDownloadProgress(downloadId) {
  const { apiUrl, addDownload, markFailed } = useHistory()
  const [progress, setProgress] = useState(0)

  useEffect(() => {
    let eventSource = null
    let cancelled = false

    const resolveIfReady = async () => {
      const all = await fetchDownloads(apiUrl)
      if (cancelled) return false
      const found = all.find((d) => d.downloadId === downloadId && !d.expired)
      if (!found) return false
      addDownload(found)
      return true
    }

    // Defer to a microtask so StrictMode's synchronous double-mount cleanup
    // cancels the duplicate before it opens a connection.
    const startTimer = setTimeout(() => {
      eventSource = new EventSource(`${apiUrl}/api/download/progress/${downloadId}`)

      eventSource.onmessage = async (event) => {
        const data = JSON.parse(event.data)
        if (data.type === 'ping') return
        if (data.type === 'progress') {
          setProgress(data.progress)
        } else if (data.type === 'complete') {
          eventSource.close()
          addDownload(data.data)
        } else if (data.type === 'error') {
          eventSource.close()
          try {
            if (await resolveIfReady()) return
          } catch {
            // fall through to marking the row failed
          }
          if (!cancelled) markFailed(downloadId)
        }
      }
      // No onerror handler: a mere transport drop should let EventSource
      // auto-reconnect and re-attach to the still-running job. Terminal states
      // arrive as `error`/`complete` data frames handled above.
    }, 0)

    return () => {
      clearTimeout(startTimer)
      cancelled = true
      if (eventSource) eventSource.close()
    }
  }, [apiUrl, downloadId, addDownload, markFailed])

  return progress
}
