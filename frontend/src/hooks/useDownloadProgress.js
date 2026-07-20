import { useEffect, useRef, useState } from 'react'
import { useHistory } from '../context/useHistory'
import { fetchDownloads } from '../lib/media'

// Shared observer for a download job's SSE. Opens the pure-observer stream
// (/api/download/progress/:id — no extra yt-dlp process, and multiple clients can
// watch one job), returns live progress (rounded 0–100), and routes terminal
// events. Both the Downloads-list card and the dedicated DownloadPage consume it,
// so the EventSource lifecycle, the StrictMode double-mount guard, and the
// file-list reconcile live in exactly one place.
//
// Terminal behavior differs per caller, so it's supplied as callbacks:
//  - onComplete(data): after the row is upgraded in place (addDownload). The card
//    passes nothing; DownloadPage navigates to /play.
//  - onError(message): after reconciling the file list (in case the job just
//    finished and was swept). Defaults to markFailed(downloadId); DownloadPage
//    overrides to also surface the error + carry fallback row fields.
//  - onTransportError(): a mere transport blip (dropped keep-alive). When given,
//    the stream is closed and the callback runs (after a reconcile). When omitted,
//    EventSource's native auto-reconnect re-attaches to the still-running job —
//    the right default for a passive list row.
export function useDownloadProgress(downloadId, callbacks = {}) {
  const { apiUrl, addDownload, markFailed } = useHistory()
  const [progress, setProgress] = useState(0)
  // Hold the latest callbacks in a ref so callers can pass inline closures
  // without re-subscribing the SSE every render.
  const cbRef = useRef(callbacks)
  cbRef.current = callbacks

  useEffect(() => {
    let eventSource = null
    let cancelled = false

    // Reconcile against the file list: if the download is present (and not
    // expired), adopt it. Recovers when the SSE reports "not found"/error but the
    // file actually landed (job swept after completion, or a transient drop).
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
      // withCredentials so the session cookie rides the SSE (this route is behind
      // requireAuth); harmless same-origin.
      eventSource = new EventSource(`${apiUrl}/api/download/progress/${downloadId}`, {
        withCredentials: true,
      })

      eventSource.onmessage = async (event) => {
        const data = JSON.parse(event.data)
        if (data.type === 'ping') return
        if (data.type === 'progress') {
          // Round before setState so sub-percent frames (42.1 → 42.4 → …) don't
          // each trigger a re-render — only the ~100 integer boundaries do.
          const next = Math.round(Math.max(0, Math.min(100, data.progress)))
          setProgress((prev) => (prev === next ? prev : next))
        } else if (data.type === 'complete') {
          eventSource.close()
          setProgress(100)
          addDownload(data.data)
          cbRef.current.onComplete?.(data.data)
        } else if (data.type === 'error') {
          eventSource.close()
          try {
            if (await resolveIfReady()) return
          } catch {
            // fall through to the failure handler
          }
          if (cancelled) return
          if (cbRef.current.onError) cbRef.current.onError(data.error)
          else markFailed(downloadId)
        }
      }

      // A transport blip is left to EventSource's native auto-reconnect unless a
      // caller opts into handling it (then close + reconcile before notifying).
      if (cbRef.current.onTransportError) {
        eventSource.onerror = async () => {
          eventSource.close()
          try {
            if (await resolveIfReady()) return
          } catch {
            // fall through
          }
          if (!cancelled) cbRef.current.onTransportError()
        }
      }
    }, 0)

    return () => {
      clearTimeout(startTimer)
      cancelled = true
      if (eventSource) eventSource.close()
    }
  }, [apiUrl, downloadId, addDownload, markFailed])

  return progress
}
