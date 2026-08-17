import { writeText } from './storage'

// Dark/light theme, persisted in localStorage and applied as a class on <html>.
// The initial class is set by the no-FOUC inline script in index.html; this
// module keeps runtime toggles in sync with that same storage key.
//
// Stored as a bare string via `writeText`, never `writeJson`: that inline
// script compares the raw value with `t === 'dark'`, so a JSON-quoted `"dark"`
// would read as "no preference" and reset every existing user to their system
// default on the next load.
const STORAGE_KEY = 'tubekeepTheme'

export function getTheme() {
  return document.documentElement.classList.contains('dark') ? 'dark' : 'light'
}

export function applyTheme(theme) {
  const dark = theme === 'dark'
  const root = document.documentElement
  root.classList.toggle('dark', dark)
  root.classList.toggle('light', !dark)
  // storage may be unavailable (private mode) — the class still applies
  writeText(localStorage, STORAGE_KEY, theme)
}

export function toggleTheme() {
  const next = getTheme() === 'dark' ? 'light' : 'dark'
  applyTheme(next)
  return next
}
