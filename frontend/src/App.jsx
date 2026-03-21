import { useState, useEffect, useRef } from 'react'
import UrlInput from './components/UrlInput'
import FormatSelector from './components/FormatSelector'
import ProgressBar from './components/ProgressBar'
import VideoPlayer from './components/VideoPlayer'
import DownloadHistory from './components/DownloadHistory'
import './App.css'

const API_URL = 'http://localhost:3001'
const STORAGE_KEY = 'ytDownloaderHistory'

function App() {
  const [videoInfo, setVideoInfo] = useState(null)
  const [loading, setLoading] = useState(false)
  const [downloading, setDownloading] = useState(false)
  const [downloadProgress, setDownloadProgress] = useState(0)
  const [currentDownload, setCurrentDownload] = useState(null)
  const [activeDownload, setActiveDownload] = useState(null)
  const [error, setError] = useState(null)
  const [history, setHistory] = useState([])
  const [isReady, setIsReady] = useState(false)
  
  const historyRef = useRef([])
  const isLoadedRef = useRef(false)

  // Load from localStorage on first mount
  useEffect(() => {
    if (isLoadedRef.current) return
    
    try {
      const saved = localStorage.getItem(STORAGE_KEY)
      if (saved) {
        const parsed = JSON.parse(saved)
        console.log('📥 Loaded from localStorage:', parsed.length, 'items')
        setHistory(parsed)
        historyRef.current = parsed
      } else {
        console.log('📭 No data in localStorage')
      }
    } catch (err) {
      console.error('❌ Error loading from localStorage:', err)
    }
    
    isLoadedRef.current = true
    setIsReady(true)
  }, [])

  // Check for redownload URL
  useEffect(() => {
    const redownloadUrl = localStorage.getItem('redownloadUrl')
    if (redownloadUrl) {
      console.log('🔄 Redownload requested for:', redownloadUrl)
      // Clear the stored URL
      localStorage.removeItem('redownloadUrl')
      // Auto-fetch the video info
      fetchVideoInfo(redownloadUrl)
    }
  }, [isReady])

  // Save to localStorage whenever history changes
  useEffect(() => {
    if (!isReady) return
    
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(history))
      console.log('💾 Saved to localStorage:', history.length, 'items')
      historyRef.current = history
    } catch (err) {
      console.error('❌ Error saving to localStorage:', err)
    }
  }, [history, isReady])

  // Sync with server after initial load
  useEffect(() => {
    if (!isReady) return
    
    const syncWithServer = async () => {
      try {
        const response = await fetch(`${API_URL}/api/files`)
        const data = await response.json()
        
        if (data.success && data.data) {
          const serverDownloads = data.data.map(d => ({
            downloadId: d.downloadId,
            url: d.url,
            title: d.title,
            thumbnail: d.thumbnail,
            formatId: d.formatId,
            type: d.type,
            filename: d.filename,
            size: d.size,
            createdAt: d.createdAt,
            fileUrl: `${API_URL}/api/files/${d.downloadId}/${encodeURIComponent(d.filename)}`
          }))
          
          // Merge server data with local history
          const localIds = new Set(historyRef.current.map(d => d.downloadId))
          const newFromServer = serverDownloads.filter(d => !localIds.has(d.downloadId))
          
          if (newFromServer.length > 0) {
            console.log('🌐 Found', newFromServer.length, 'new downloads from server')
            const merged = [...newFromServer, ...historyRef.current]
              .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
            
            setHistory(merged)
          }
        }
      } catch (err) {
        console.error('❌ Server sync error:', err)
      }
    }
    
    syncWithServer()
  }, [isReady])

  const fetchVideoInfo = async (url) => {
    setLoading(true)
    setError(null)
    setVideoInfo(null)
    
    try {
      const response = await fetch(`${API_URL}/api/info?url=${encodeURIComponent(url)}`)
      const data = await response.json()
      
      if (!data.success) {
        throw new Error(data.error)
      }
      
      setVideoInfo({
        ...data.data,
        originalUrl: url
      })
    } catch (err) {
      setError(err.message || 'Failed to fetch video info')
    } finally {
      setLoading(false)
    }
  }

  const startDownload = async (formatId, type) => {
    setDownloading(true)
    setDownloadProgress(0)
    setError(null)
    
    try {
      const response = await fetch(`${API_URL}/api/download`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url: videoInfo.originalUrl,
          formatId,
          type,
          title: videoInfo.title,
          thumbnail: videoInfo.thumbnail
        })
      })
      
      const data = await response.json()
      
      if (!data.success) {
        throw new Error(data.error)
      }
      
      const { downloadId } = data.data
      setCurrentDownload(downloadId)
      
      const eventSource = new EventSource(
        `${API_URL}/api/download/progress/${downloadId}?` +
        `url=${encodeURIComponent(videoInfo.originalUrl)}&` +
        `formatId=${formatId}&` +
        `type=${type}&` +
        `title=${encodeURIComponent(videoInfo.title)}&` +
        `thumbnail=${encodeURIComponent(videoInfo.thumbnail || '')}`
      )
      
      eventSource.onmessage = (event) => {
        const eventData = JSON.parse(event.data)
        
        if (eventData.type === 'progress') {
          setDownloadProgress(eventData.progress)
        } else if (eventData.type === 'complete') {
          console.log('✅ Download complete:', eventData.data)
          setDownloadProgress(100)
          setActiveDownload(eventData.data)
          
          // Add to history
          setHistory(prev => {
            const newHistory = [eventData.data, ...prev]
            console.log('📋 History updated:', newHistory.length, 'items')
            return newHistory
          })
          
          eventSource.close()
          setDownloading(false)
        } else if (eventData.type === 'error') {
          throw new Error(eventData.error)
        }
      }
      
      eventSource.onerror = (err) => {
        console.error('❌ EventSource error:', err)
        eventSource.close()
        setDownloading(false)
        setError('Download connection lost')
      }
    } catch (err) {
      console.error('❌ Download error:', err)
      setError(err.message || 'Download failed')
      setDownloading(false)
    }
  }

  const handleDelete = (downloadId) => {
    fetch(`${API_URL}/api/files/${downloadId}`, { method: 'DELETE' })
      .then(() => {
        setHistory(prev => prev.filter(d => d.downloadId !== downloadId))
        if (activeDownload?.downloadId === downloadId) {
          setActiveDownload(null)
        }
      })
      .catch(err => console.error('❌ Delete error:', err))
  }

  const handlePlay = (download) => {
    console.log('▶️ Playing:', download)
    setActiveDownload(download)
    setVideoInfo(null)
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }

  const reset = () => {
    setVideoInfo(null)
    setActiveDownload(null)
    setCurrentDownload(null)
    setDownloadProgress(0)
    setError(null)
  }

  // Debug: log current state
  console.log('🔄 App render - history:', history.length, 'active:', activeDownload?.downloadId || 'none')

  return (
    <div className="app">
      <header className="header">
        <h1>Video Downloader</h1>
        <p>Download videos from YouTube and other platforms</p>
      </header>

      <main className="main">
        {!videoInfo && !activeDownload && !downloading && (
          <UrlInput onSubmit={fetchVideoInfo} loading={loading} />
        )}

        {error && (
          <div className="error">
            <p>{error}</p>
            <button onClick={() => setError(null)}>Dismiss</button>
          </div>
        )}

        {videoInfo && !downloading && !activeDownload && (
          <FormatSelector
            info={videoInfo}
            onDownload={startDownload}
            onCancel={reset}
          />
        )}

        {downloading && (
          <ProgressBar progress={downloadProgress} downloadId={currentDownload} />
        )}

        {activeDownload && (
          <VideoPlayer
            download={activeDownload}
            apiUrl={API_URL}
            onReset={reset}
          />
        )}

        <DownloadHistory
          downloads={history}
          apiUrl={API_URL}
          onDelete={handleDelete}
          onPlay={handlePlay}
        />
      </main>
    </div>
  )
}

export default App
