import { useEffect, useRef, useState, useMemo, useCallback } from 'react'
import {
  HistoryContext,
  HISTORY_API_URL,
  HISTORY_STORAGE_KEY,
  EXPIRED_STORAGE_KEY,
  HISTORY_EXPIRY_MS
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
    fileUrl: `${HISTORY_API_URL}/api/files/${d.downloadId}/${encodeURIComponent(d.filename)}`
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
        const response = await fetch(`${HISTORY_API_URL}/api/files`)
        const data = await response.json()
        if (cancelled) return
        if (!data.success || !Array.isArray(data.data)) return

        const serverDownloads = data.data.map(decorate)
        const serverIds = new Set(serverDownloads.map(d => d.downloadId))
        const local = historyRef.current

        const stillAlive = local.filter(d => serverIds.has(d.downloadId))
        const stalePrunable = local.filter(d => !serverIds.has(d.downloadId))

        const aliveIds = new Set(stillAlive.map(d => d.downloadId))
        const newFromServer = serverDownloads.filter(d => !aliveIds.has(d.downloadId))

        const merged = [...newFromServer, ...stillAlive]
          .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))

        setHistory(merged)
        setExpired(prev => {
          const seenIds = new Set([...prev.map(d => d.downloadId), ...serverIds])
          const newlyExpired = stalePrunable.filter(d => !seenIds.has(d.downloadId))
          return [...newlyExpired, ...prev]
            .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
        })
      } catch (err) {
        console.error('❌ Server sync error:', err)
      }
    }

    sync()
    return () => { cancelled = true }
  }, [])

  const addDownload = useCallback((download) => {
    const decorated = decorate(download)
    setHistory(prev => {
      const without = prev.filter(d => d.downloadId !== decorated.downloadId)
      return [decorated, ...without]
    })
    setExpired(prev => {
      if (!decorated.url) return prev
      return prev.filter(d => d.url !== decorated.url)
    })
  }, [])

  const removeDownload = useCallback(async (downloadId) => {
    try {
      await fetch(`${HISTORY_API_URL}/api/files/${downloadId}`, { method: 'DELETE' })
    } catch (err) {
      console.error('❌ Delete error:', err)
    }
    setHistory(prev => prev.filter(d => d.downloadId !== downloadId))
    setExpired(prev => prev.filter(d => d.downloadId !== downloadId))
  }, [])

  const forgetExpired = useCallback((downloadId) => {
    setExpired(prev => prev.filter(d => d.downloadId !== downloadId))
  }, [])

  const findById = useCallback((downloadId) => {
    return historyRef.current.find(d => d.downloadId === downloadId) || null
  }, [])

  const value = useMemo(() => ({
    history,
    expired,
    apiUrl: HISTORY_API_URL,
    expiryMs: HISTORY_EXPIRY_MS,
    addDownload,
    removeDownload,
    forgetExpired,
    findById
  }), [history, expired, addDownload, removeDownload, forgetExpired, findById])

  return <HistoryContext.Provider value={value}>{children}</HistoryContext.Provider>
}
