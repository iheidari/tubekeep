import { createContext } from 'react'

export const HistoryContext = createContext(null)

export const HISTORY_API_URL =
  import.meta.env.VITE_API_URL || (typeof window !== 'undefined' ? window.location.origin : '')

export const HISTORY_STORAGE_KEY = 'ytDownloaderHistory'
export const EXPIRED_STORAGE_KEY = 'ytDownloaderExpired'

export const HISTORY_EXPIRY_MS = 24 * 60 * 60 * 1000
