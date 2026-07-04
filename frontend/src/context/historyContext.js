import { createContext } from 'react'
import { API_URL } from '../lib/media'

export const HistoryContext = createContext(null)

// Single source of truth lives in lib/media (API_URL); re-exported here under
// the name the history layer already uses.
export const HISTORY_API_URL = API_URL

export const HISTORY_STORAGE_KEY = 'ytDownloaderHistory'
export const EXPIRED_STORAGE_KEY = 'ytDownloaderExpired'
