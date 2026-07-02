import { useEffect, useState } from 'react'
import { Navigate, useNavigate, useSearchParams } from 'react-router-dom'
import BackLink from '../components/BackLink'
import FormatSelector from '../components/FormatSelector'
import { useHistory } from '../context/useHistory'

function InfoPage() {
  const [searchParams] = useSearchParams()
  const navigate = useNavigate()
  const { apiUrl } = useHistory()
  const url = searchParams.get('url')

  const [info, setInfo] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [startingFormat, setStartingFormat] = useState(null)

  useEffect(() => {
    if (!url) return
    let cancelled = false
    setLoading(true)
    setError(null)
    setInfo(null)

    fetch(`${apiUrl}/api/info?url=${encodeURIComponent(url)}`)
      .then((r) => r.json())
      .then((data) => {
        if (cancelled) return
        if (!data.success) throw new Error(data.error)
        setInfo({ ...data.data, originalUrl: url })
      })
      .catch((err) => {
        if (cancelled) return
        setError(err.message || 'Failed to fetch video info')
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [url, apiUrl])

  if (!url) return <Navigate to="/" replace />

  const handleDownload = async (formatId, type, keep) => {
    setStartingFormat(formatId)
    setError(null)
    try {
      const response = await fetch(`${apiUrl}/api/download`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url: info.originalUrl,
          formatId,
          type,
          title: info.title,
          thumbnail: info.thumbnail,
        }),
      })
      const data = await response.json()
      if (!data.success) throw new Error(data.error)

      const { downloadId } = data.data
      navigate(`/download/${downloadId}`, {
        replace: true,
        state: {
          start: true,
          url: info.originalUrl,
          formatId,
          type,
          title: info.title,
          thumbnail: info.thumbnail,
          keep,
        },
      })
    } catch (err) {
      setError(err.message || 'Failed to start download')
      setStartingFormat(null)
    }
  }

  const backLink = <BackLink />

  if (loading) {
    return (
      <div className="max-w-4xl mx-auto">
        {backLink}
        <div className="bg-surface-container-lowest border border-surface-variant rounded-xl p-12 text-center">
          <span className="material-symbols-outlined animate-spin text-[40px] text-primary mb-3 block">
            progress_activity
          </span>
          <p className="font-body-md text-body-md text-secondary">Fetching video info…</p>
        </div>
      </div>
    )
  }

  if (error) {
    return (
      <div className="max-w-4xl mx-auto">
        {backLink}
        <div className="bg-error-container border border-error rounded-xl p-6 text-center">
          <span className="material-symbols-outlined text-[40px] text-error mb-2 block">error</span>
          <p className="font-body-md text-body-md text-on-error-container mb-4">{error}</p>
          <button
            type="button"
            onClick={() => navigate('/')}
            className="bg-primary text-on-primary px-4 py-2 rounded-lg font-label-md text-label-md hover:bg-primary-container transition-colors"
          >
            Back to home
          </button>
        </div>
      </div>
    )
  }

  if (!info) return null

  return <FormatSelector info={info} onDownload={handleDownload} startingFormat={startingFormat} />
}

export default InfoPage
