import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { apiFetch, fetchDownloads, fileUrl } from '../lib/media'
import { HISTORY_API_URL, HistoryContext, LEGACY_HISTORY_KEYS } from './historyContext.js'
import { useAuth } from './useAuth.js'

// The per-user `downloads` table is the source of truth for history (0XC-100).
// This provider is a cache of it: it loads the user's rows on mount (and again
// whenever the signed-in user changes), applies each mutation optimistically for
// a responsive UI, and sends the matching request to the server. Nothing is
// persisted in the browser any more — a reload re-reads the server, so history
// follows the account across devices instead of the machine.

// Attach the playable/downloadable URL. A row without a filename (still
// downloading, failed, or expired) has no file to point at, so it's left alone
// rather than given a URL to nowhere.
function decorate(d) {
  if (!d.filename) return d
  return {
    ...d,
    fileUrl: fileUrl(HISTORY_API_URL, d.downloadId, d.filename),
  }
}

const byNewest = (a, b) => new Date(b.createdAt) - new Date(a.createdAt)

// Does the freshly-completed download `fresh` replace the existing row `row`?
// One row per source URL (0XC-10). The SERVER owns this rule — it runs in the
// download job's completion hook, so it applies even when no tab is watching the
// SSE. This mirror exists only so the list updates instantly instead of waiting
// for the next sync; it issues no requests. Keep the two spared cases in step
// with the store's supersedeForUser: a moved-to-cloud row still links to a live
// cloud copy, and a `downloading` row belongs to a concurrent job.
function supersededBy(fresh, row) {
  if (row.downloadId === fresh.downloadId) return false
  if (!fresh.url || row.url !== fresh.url) return false
  return !row.moved && row.status !== 'downloading'
}

// Hard-delete a download's server-side row (media included). Used when the
// visitor permanently forgets an expired, moved, or failed card.
async function forgetOnServer(downloadId) {
  try {
    await apiFetch(`${HISTORY_API_URL}/api/files/${downloadId}?permanent=true`, {
      method: 'DELETE',
    })
  } catch (err) {
    console.error('❌ Forget error:', err)
  }
}

// One-time sweep of the pre-0XC-100 localStorage history, so an upgrading
// visitor doesn't carry a dead copy of someone's list around forever.
function clearLegacyStorage() {
  for (const key of LEGACY_HISTORY_KEYS) {
    try {
      localStorage.removeItem(key)
    } catch {
      // ignore unavailable localStorage
    }
  }
}

export function HistoryProvider({ children }) {
  const { user } = useAuth()
  const [history, setHistory] = useState([])
  const [expired, setExpired] = useState([])
  const historyRef = useRef(history)

  useEffect(() => {
    historyRef.current = history
  }, [history])

  useEffect(clearLegacyStorage, [])

  // Load the signed-in user's rows. Re-runs when the account changes so a logout
  // (or a login as someone else) never leaves the previous user's list on screen.
  const userKey = user?.email || null
  useEffect(() => {
    if (!userKey) {
      setHistory([])
      setExpired([])
      return
    }

    let cancelled = false
    const sync = async () => {
      try {
        const all = await fetchDownloads(HISTORY_API_URL)
        if (cancelled) return

        // Everything that isn't expired stays in the active list — including the
        // `downloading` and `failed` rows the Downloads page renders as their own
        // cards. Those are server-side now (POST /api/download records the
        // download before starting it), so they survive a reload without any
        // client-side preservation. A "moved to cloud" row keeps its source URL +
        // cloud link even though the media is gone, so it also stays active (as a
        // "Moved" card) rather than being listed as expired.
        setHistory(
          all
            .filter((d) => d.moved || !d.expired)
            .map(decorate)
            .sort(byNewest),
        )
        setExpired(
          all
            .filter((d) => d.expired && !d.moved)
            .map(decorate)
            .sort(byNewest),
        )
      } catch (err) {
        console.error('❌ Server sync error:', err)
      }
    }

    sync()
    return () => {
      cancelled = true
    }
  }, [userKey])

  const addDownload = useCallback((download) => {
    const decorated = decorate(download)
    setHistory((prev) => {
      const without = prev.filter((d) => d.downloadId !== decorated.downloadId)
      return [decorated, ...without].filter((d) => !supersededBy(decorated, d))
    })
    setExpired((prev) => prev.filter((d) => !supersededBy(decorated, d)))
  }, [])

  // Show a "Downloading…" row the moment a download starts. The server already
  // recorded it (POST /api/download writes the row before starting the job); this
  // just avoids waiting for a re-sync to see it. Deduped by downloadId,
  // prepended; a later addDownload on completion replaces the whole record
  // (dropping the status) so it upgrades to a normal completed card. Not
  // decorated — it has no filename yet.
  const startPending = useCallback((row) => {
    setHistory((prev) => {
      const without = prev.filter((d) => d.downloadId !== row.downloadId)
      return [{ ...row, status: 'downloading' }, ...without]
    })
  }, [])

  // Flip a pending row to "failed" when the SSE errors (the server marks its own
  // row failed through the job's terminal hook). Updates in place if the
  // placeholder is present (the common path); otherwise inserts a failed row
  // from whatever start fields the caller has, so the failure is never silent.
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

  // Permanently forget a download — the one "get rid of this row for good" path,
  // shared by the failed, expired and moved cards. All three hold a row that
  // exists server-side (and would come back on the next sync), and none has media
  // worth keeping or re-expiring: a failed download never landed, an expired one
  // already lost its files, and a moved one lives in the visitor's cloud now. So
  // hard-delete server-side first, then drop the id from both lists (it only ever
  // lives in one, so the other filter is a no-op).
  const forgetDownload = useCallback(async (downloadId) => {
    await forgetOnServer(downloadId)
    setHistory((prev) => prev.filter((d) => d.downloadId !== downloadId))
    setExpired((prev) => prev.filter((d) => d.downloadId !== downloadId))
  }, [])

  // Cancel an in-flight download: the job runs server-side regardless of the
  // client, so it must be explicitly stopped. DELETE aborts the job, removes its
  // partial files and drops its history row; then drop the row locally
  // (fire-and-forget — the row goes either way).
  const cancelDownload = useCallback(async (downloadId) => {
    try {
      await apiFetch(`${HISTORY_API_URL}/api/download/${downloadId}`, { method: 'DELETE' })
    } catch (err) {
      console.error('❌ Cancel error:', err)
    }
    setHistory((prev) => prev.filter((d) => d.downloadId !== downloadId))
  }, [])

  const removeDownload = useCallback(async (downloadId) => {
    try {
      await apiFetch(`${HISTORY_API_URL}/api/files/${downloadId}`, { method: 'DELETE' })
    } catch (err) {
      console.error('❌ Expire error:', err)
    }
    const removed = historyRef.current.find((d) => d.downloadId === downloadId)
    setHistory((prev) => prev.filter((d) => d.downloadId !== downloadId))
    if (removed) {
      setExpired((prev) => {
        const without = prev.filter((d) => d.downloadId !== downloadId)
        const entry = { ...removed, expired: true, expiredAt: new Date().toISOString() }
        return [entry, ...without].sort(byNewest)
      })
    }
  }, [])

  const setKept = useCallback(async (downloadId, kept) => {
    // Optimistic update; revert on failure.
    setHistory((prev) => prev.map((d) => (d.downloadId === downloadId ? { ...d, kept } : d)))
    try {
      const response = await apiFetch(`${HISTORY_API_URL}/api/files/${downloadId}?kept=${kept}`, {
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

  // Flag a download as moved to the visitor's cloud. The server flags its own row
  // when the upload job finishes (keeping the source URL + cloud link, dropping
  // the media), so we only mirror that locally: the row stays visible as a
  // "Moved" card with an "Open in <provider>" link.
  const markMoved = useCallback((downloadId, info) => {
    setHistory((prev) =>
      prev.map((d) => (d.downloadId === downloadId ? { ...d, moved: info || {} } : d)),
    )
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
      forgetDownload,
      cancelDownload,
      removeDownload,
      setKept,
      findById,
      markMoved,
    }),
    [
      history,
      expired,
      addDownload,
      startPending,
      markFailed,
      forgetDownload,
      cancelDownload,
      removeDownload,
      setKept,
      findById,
      markMoved,
    ],
  )

  return <HistoryContext.Provider value={value}>{children}</HistoryContext.Provider>
}
