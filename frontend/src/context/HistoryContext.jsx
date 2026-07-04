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

export function HistoryProvider({ children }) {
  const [history, setHistory] = useState(() => loadKey(HISTORY_STORAGE_KEY))
  const [expired, setExpired] = useState(() => loadKey(EXPIRED_STORAGE_KEY))
  const historyRef = useRef(history)

  useEffect(() => {
    historyRef.current = history
    try {
      localStorage.setItem(HISTORY_STORAGE_KEY, JSON.stringify(history))
    } catch (err) {
      console.error('❌ Error saving history to localStorage:', err)
    }
  }, [history])

  useEffect(() => {
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
        const active = all
          .filter((d) => !d.expired)
          .map(decorate)
          .sort(sortByDate)
        const expiredFromServer = all.filter((d) => d.expired).sort(sortByDate)

        // A "moved to cloud" file is hard-deleted server-side, so it won't come
        // back from the server — but its row lives on locally so the visitor can
        // still click "Open in Dropbox". Preserve those local moved rows.
        const serverIds = new Set(all.map((d) => d.downloadId))
        const preservedMoved = loadKey(HISTORY_STORAGE_KEY).filter(
          (d) => d.moved && !serverIds.has(d.downloadId),
        )

        setHistory([...active, ...preservedMoved].sort(sortByDate))
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
    setExpired((prev) => {
      if (!decorated.url) return prev
      return prev.filter((d) => d.url !== decorated.url)
    })
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
    try {
      await fetch(`${HISTORY_API_URL}/api/files/${downloadId}?permanent=true`, { method: 'DELETE' })
    } catch (err) {
      console.error('❌ Forget error:', err)
    }
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

  // Flag a download as moved to the visitor's cloud. The server has already
  // hard-deleted the file, so we only update local state: the row stays visible
  // as a "Moved" card with an "Open in Dropbox" link.
  const markMoved = useCallback((downloadId, info) => {
    setHistory((prev) =>
      prev.map((d) => (d.downloadId === downloadId ? { ...d, moved: info || {} } : d)),
    )
    setExpired((prev) => prev.filter((d) => d.downloadId !== downloadId))
  }, [])

  // Remove a row from local state only — no server call. Used to dismiss a moved
  // card (the underlying file is already gone from our server).
  const dropLocal = useCallback((downloadId) => {
    setHistory((prev) => prev.filter((d) => d.downloadId !== downloadId))
    setExpired((prev) => prev.filter((d) => d.downloadId !== downloadId))
  }, [])

  const value = useMemo(
    () => ({
      history,
      expired,
      apiUrl: HISTORY_API_URL,
      addDownload,
      removeDownload,
      forgetExpired,
      setKept,
      findById,
      markMoved,
      dropLocal,
    }),
    [
      history,
      expired,
      addDownload,
      removeDownload,
      forgetExpired,
      setKept,
      findById,
      markMoved,
      dropLocal,
    ],
  )

  return <HistoryContext.Provider value={value}>{children}</HistoryContext.Provider>
}
