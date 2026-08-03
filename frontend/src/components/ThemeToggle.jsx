import { useState } from 'react'
import { getTheme, toggleTheme } from '../lib/theme'

// Header control to flip dark mode. Reads the current class on mount (set by the
// no-FOUC script) and stays in sync on click.
function ThemeToggle() {
  const [theme, setTheme] = useState(getTheme)

  const flip = () => setTheme(toggleTheme())

  const dark = theme === 'dark'
  return (
    <button
      type="button"
      onClick={flip}
      title={dark ? 'Switch to light mode' : 'Switch to dark mode'}
      aria-label={dark ? 'Switch to light mode' : 'Switch to dark mode'}
      className="w-9 h-9 flex items-center justify-center rounded-full text-muted hover:text-ink hover:bg-tint transition-colors"
    >
      <span className="material-symbols-outlined text-[20px]" aria-hidden="true">
        {dark ? 'light_mode' : 'dark_mode'}
      </span>
    </button>
  )
}

export default ThemeToggle
