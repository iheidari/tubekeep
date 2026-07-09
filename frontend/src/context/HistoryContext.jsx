import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { fetchDownloads, fileUrl } from '../lib/media'
import {
  EXPIRED_STORAGE_KEY,
  HISTORY_API_URL,
  HISTORY_STORAGE_KEY,
  HistoryContext,
} from './historyContext.js'

function loadKey(key) {
  try {
    const saved = localStorage.getItem(key)
    if (saved) return JSON.parse(saved)
  } catch (err) {
    console.error(`❌ Error loading ${key} from localStorage:`, err)
  }
  return []
}

function decorate(d) {
  return {
    ...d,
    fileUrl: fileUrl(HISTORY_API_URL, d.downloadId, d.filename),
  }
}

// Hard-delete a download's server-side row (metadata included). Used when the
// visitor permanently forgets an expired or moved card.
async function forgetOnServer(downloadId) {
  try {
    await fetch(`${HISTORY_API_URL}/api/files/${downloadId}?permanent=true`, { method: 'DELETE' })
  } catch (err) {
    console.error('❌ Forget error:', err)
  }
}

export function HistoryProvider({ children }) {
  const [history, setHistory] = useState(() => loadKey(HISTORY_STORAGE_KEY))
  const [expired, setExpired] = useState(() => loadKey(EXPIRED_STORAGE_KEY))
  const historyRef = useRef(history)
  const expiredRef = useRef(expired)

  useEffect(() => {
    historyRef.current = history
    try {
      localStorage.setItem(HISTORY_STORAGE_KEY, JSON.stringify(history))
    } catch (err) {
      console.error('❌ Error saving history to localStorage:', err)
    }
  }, [history])

  useEffect(() => {
    expiredRef.current = expired
    try {
      localStorage.setItem(EXPIRED_STORAGE_KEY, JSON.stringify(expired))
    } catch (err) {
      console.error('❌ Error saving expired to localStorage:', err)
    }
  }, [expired])

  useEffect(() => {
    let cancelled = false
    const sync = async () => {
      try {
        const all = await fetchDownloads(HISTORY_API_URL)
        if (cancelled) return

        const sortByDate = (a, b) => new Date(b.createdAt) - new Date(a.createdAt)
        // `active` and `movedFromServer` both feed the combined setHistory sort
        // below, so they don't need their own sort; only expiredFromServer feeds
        // setExpired directly and must be pre-sorted.
        const active = all.filter((d) => !d.expired && !d.moved).map(decorate)
        // A "moved to cloud" file keeps its metadata row server-side (source URL
        // + cloud link) even though the media is gone, so it comes back from the
        // server as a moved row — surfaced as a "Moved" card, not expired.
        const movedFromServer = all.filter((d) => d.moved)
        const expiredFromServer = all.filter((d) => d.expired && !d.moved).sort(sortByDate)

        // Any local moved rows the server no longer knows about (moved before we
        // persisted them server-side) still live on so their link isn't lost.
        const serverIds = new Set(all.map((d) => d.downloadId))
        const localRows = loadKey(HISTORY_STORAGE_KEY)
        const preservedMoved = localRows.filter((d) => d.moved && !serverIds.has(d.downloadId))
        // Pending/failed rows are written client-side at click time and aren't on
        // the server yet, so a reload mid-download would otherwise wipe them.
        // Keep the ones the server doesn't know about; a completed one reappears
        // in `active` (its id is in serverIds) and supersedes the placeholder.
        const preservedPending = localRows.filter(
          (d) =>
            (d.status === 'downloading' || d.status === 'failed') && !serverIds.has(d.downloadId),
        )

        setHistory(
          [...active, ...movedFromServer, ...preservedMoved, ...preservedPending].sort(sortByDate),
        )
        setExpired(expiredFromServer)
      } catch (err) {
        console.error('❌ Server sync error:', err)
      }
    }

    sync()
    return () => {
      cancelled = true
    }
  }, [])

  const addDownload = useCallback((download) => {
    const decorated = decorate(download)
    setHistory((prev) => {
      const without = prev.filter((d) => d.downloadId !== decorated.downloadId)
      return [decorated, ...without]
    })
    if (decorated.url) {
      // A completed re-download supersedes any older expired row for the same
      // source URL. Compute that stale set once, then (a) best-effort hard-delete
      // it server-side via the existing permanent-delete endpoint so the
      // mount-time sync() won't resurrect it on reload, and (b) drop it locally.
      // The delete is fire-and-forget, so a failed request can still let the row
      // reappear on the next sync. The downloadId guard keeps us from deleting the
      // freshly-completed row itself. Moved-to-cloud rows live in `history`, not
      // `expired`, so they are left untouched.
      const stale = expiredRef.current.filter(
        (d) => d.url === decorated.url && d.downloadId !== decorated.downloadId,
      )
      for (const d of stale) forgetOnServer(d.downloadId)
      const staleIds = new Set(stale.map((d) => d.downloadId))
      setExpired((prev) => prev.filter((d) => !staleIds.has(d.downloadId)))
    }
  }, [])

  // Write a placeholder row the moment a download starts (before the SSE runs),
  // so it shows up in the Downloads list immediately and survives in-session
  // navigation. Deduped by downloadId, prepended; a later addDownload on
  // completion replaces the whole record (dropping the status) so it upgrades
  // to a normal completed card. Not decorated — it has no filename yet.
  const startPending = useCallback((row) => {
    setHistory((prev) => {
      const without = prev.filter((d) => d.downloadId !== row.downloadId)
      return [{ ...row, status: 'downloading' }, ...without]
    })
  }, [])

  // Flip a pending row to "failed" when the SSE errors. Updates in place if the
  // placeholder is present (the common path); otherwise inserts a failed row
  // from whatever start fields the caller has, so the failure is never silent.
  // The insert carries createdAt so it sorts alongside the other rows (the
  // in-place path already has one from startPending).
  const markFailed = useCallback((downloadId, fallback = {}) => {
    setHistory((prev) => {
      if (prev.some((d) => d.downloadId === downloadId)) {
        return prev.map((d) => (d.downloadId === downloadId ? { ...d, status: 'failed' } : d))
      }
      const entry = {
        ...fallback,
        downloadId,
        createdAt: new Date().toISOString(),
        status: 'failed',
      }
      return [entry, ...prev]
    })
  }, [])

  // Drop a pending/failed row locally only — no server DELETE and no move to the
  // expired list, since its file may never have landed server-side. The history
  // effect persists the removal to localStorage.
  const dropLocal = useCallback((downloadId) => {
    setHistory((prev) => prev.filter((d) => d.downloadId !== downloadId))
  }, [])

  // Cancel an in-flight download: since the job now runs server-side regardless
  // of the client connection, a running download must be explicitly stopped.
  // DELETE aborts the job and removes its partial files; then drop the row
  // locally (fire-and-forget — the row goes either way).
  const cancelDownload = useCallback(async (downloadId) => {
    try {
      await fetch(`${HISTORY_API_URL}/api/download/${downloadId}`, { method: 'DELETE' })
    } catch (err) {
      console.error('❌ Cancel error:', err)
    }
    setHistory((prev) => prev.filter((d) => d.downloadId !== downloadId))
  }, [])

  const removeDownload = useCallback(async (downloadId) => {
    try {
      await fetch(`${HISTORY_API_URL}/api/files/${downloadId}`, { method: 'DELETE' })
    } catch (err) {
      console.error('❌ Expire error:', err)
    }
    const removed = historyRef.current.find((d) => d.downloadId === downloadId)
    setHistory((prev) => prev.filter((d) => d.downloadId !== downloadId))
    if (removed) {
      setExpired((prev) => {
        const without = prev.filter((d) => d.downloadId !== downloadId)
        const entry = { ...removed, expired: true, expiredAt: new Date().toISOString() }
        return [entry, ...without].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
      })
    }
  }, [])

  const forgetExpired = useCallback(async (downloadId) => {
    await forgetOnServer(downloadId)
    setExpired((prev) => prev.filter((d) => d.downloadId !== downloadId))
  }, [])

  const setKept = useCallback(async (downloadId, kept) => {
    // Optimistic update; revert on failure.
    setHistory((prev) => prev.map((d) => (d.downloadId === downloadId ? { ...d, kept } : d)))
    try {
      const response = await fetch(`${HISTORY_API_URL}/api/files/${downloadId}?kept=${kept}`, {
        method: 'PATCH',
      })
      const data = await response.json()
      if (!data.success) throw new Error(data.error)
    } catch (err) {
      console.error('❌ Keep toggle error:', err)
      setHistory((prev) =>
        prev.map((d) => (d.downloadId === downloadId ? { ...d, kept: !kept } : d)),
      )
    }
  }, [])

  const findById = useCallback((downloadId) => {
    return historyRef.current.find((d) => d.downloadId === downloadId) || null
  }, [])

  // Flag a download as moved to the visitor's cloud. The server keeps the
  // metadata row (source URL + cloud link) but drops the media, so we only
  // update local state: the row stays visible as a "Moved" card with an "Open
  // in Dropbox" link.
  const markMoved = useCallback((downloadId, info) => {
    setHistory((prev) =>
      prev.map((d) => (d.downloadId === downloadId ? { ...d, moved: info || {} } : d)),
    )
    setExpired((prev) => prev.filter((d) => d.downloadId !== downloadId))
  }, [])

  // Permanently forget a moved download. The server still holds its metadata row
  // (source URL + cloud link), so hard-delete it there before dropping it from
  // local state — otherwise it would reappear on the next sync.
  const forgetMoved = useCallback(async (downloadId) => {
    await forgetOnServer(downloadId)
    setHistory((prev) => prev.filter((d) => d.downloadId !== downloadId))
    setExpired((prev) => prev.filter((d) => d.downloadId !== downloadId))
  }, [])

  const value = useMemo(
    () => ({
      history,
      expired,
      apiUrl: HISTORY_API_URL,
      addDownload,
      startPending,
      markFailed,
      dropLocal,
      cancelDownload,
      removeDownload,
      forgetExpired,
      setKept,
      findById,
      markMoved,
      forgetMoved,
    }),
    [
      history,
      expired,
      addDownload,
      startPending,
      markFailed,
      dropLocal,
      cancelDownload,
      removeDownload,
      forgetExpired,
      setKept,
      findById,
      markMoved,
      forgetMoved,
    ],
  )

  return <HistoryContext.Provider value={value}>{children}</HistoryContext.Provider>
}
