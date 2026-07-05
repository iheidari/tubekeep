import { useCallback, useEffect, useRef, useState } from 'react'
import { useHistory } from '../context/useHistory'
import { connect, getDropboxConfig, getFreshAccessToken } from '../lib/dropbox'
import { API_URL } from '../lib/media'

// Drives a single download's "Move to Dropbox" flow: lazy connect (popup) →
// POST /api/cloud/upload (token in body) → SSE progress by jobId. On success it
// flags the row as moved in history (the server drops the media but keeps the
// metadata row — source URL + cloud link — so it survives across devices).
//
// phase: idle | connecting | starting | queued | uploading | complete | error
export function useCloudMove(download, { onMoved } = {}) {
  const { markMoved } = useHistory()
  const [available, setAvailable] = useState(null) // null = unknown, false = disabled
  const [phase, setPhase] = useState('idle')
  const [progress, setProgress] = useState(0)
  const [error, setError] = useState(null)
  const esRef = useRef(null)

  useEffect(() => {
    let cancelled = false
    getDropboxConfig().then((cfg) => {
      if (!cancelled) setAvailable(!!cfg?.appKey)
    })
    return () => {
      cancelled = true
    }
  }, [])

  // Close any live SSE on unmount (the server-side upload continues regardless).
  useEffect(() => {
    return () => {
      if (esRef.current) esRef.current.close()
    }
  }, [])

  const move = useCallback(async () => {
    setError(null)
    setProgress(0)
    try {
      let token
      try {
        token = await getFreshAccessToken()
      } catch (e) {
        if (e.code === 'NOT_CONNECTED') {
          setPhase('connecting')
          await connect()
          token = await getFreshAccessToken()
        } else {
          throw e
        }
      }

      setPhase('starting')
      const res = await fetch(`${API_URL}/api/cloud/upload`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          downloadId: download.downloadId,
          provider: 'dropbox',
          accessToken: token,
        }),
      })
      const body = await res.json()
      if (!body.success) throw new Error(body.error || 'Failed to start upload')

      const es = new EventSource(`${API_URL}/api/cloud/upload/${body.data.jobId}/progress`)
      esRef.current = es

      es.onmessage = (event) => {
        const data = JSON.parse(event.data)
        if (data.type === 'ping') return
        setPhase(data.status)
        if (typeof data.progress === 'number') setProgress(data.progress)

        if (data.status === 'complete') {
          es.close()
          esRef.current = null
          markMoved(download.downloadId, { link: data.result?.link, name: data.result?.name })
          onMoved?.(data.result)
        } else if (data.status === 'error') {
          es.close()
          esRef.current = null
          setError(data.error || { message: 'Upload failed' })
        }
      }

      es.onerror = () => {
        // Fires on the normal close too; only surface it if we weren't done.
        if (!esRef.current) return
        es.close()
        esRef.current = null
        setPhase('error')
        setError({ message: 'Lost connection to the upload' })
      }
    } catch (e) {
      setPhase('error')
      setError({ code: e.code, message: e.message || 'Move failed' })
    }
  }, [download.downloadId, markMoved, onMoved])

  return {
    available,
    phase,
    progress,
    error,
    move,
  }
}
