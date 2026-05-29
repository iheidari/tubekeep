import { useContext } from 'react'
import { PlayerContext } from './playerContext.js'

export function usePlayer() {
  const ctx = useContext(PlayerContext)
  if (!ctx) throw new Error('usePlayer must be used inside PlayerProvider')
  return ctx
}
