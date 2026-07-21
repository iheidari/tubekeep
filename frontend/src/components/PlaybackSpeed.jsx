import { useCallback, useEffect, useRef, useState } from 'react'
import { usePlayer } from '../context/usePlayer'

const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2]
const MENU_HANDLED_KEYS = new Set(['Escape', 'ArrowDown', 'ArrowUp', 'Home', 'End'])

// Playback-speed picker for the shared media element. Reads/sets the rate through
// the player context so the choice survives the element moving between stage and
// dock, and is reapplied after a new source loads.
function PlaybackSpeed() {
  const { playbackRate, setRate } = usePlayer()
  const [open, setOpen] = useState(false)
  const [activeIndex, setActiveIndex] = useState(0)
  const ref = useRef(null)
  const triggerRef = useRef(null)
  const optionRefs = useRef([])

  // Shared by both outside-interaction effects below.
  const isOutside = useCallback((target) => ref.current && !ref.current.contains(target), [])

  useEffect(() => {
    if (!open) return
    const onDown = (e) => {
      if (isOutside(e.target)) setOpen(false)
    }
    document.addEventListener('pointerdown', onDown)
    return () => document.removeEventListener('pointerdown', onDown)
  }, [open, isOutside])

  // Tabbing/shift-tabbing focus out of the trigger+menu group must also close the menu —
  // otherwise the panel (and its stale aria-expanded="true") stays on screen after focus
  // has moved elsewhere. Mirrors the pointerdown-outside effect above, but keyed off focus
  // moving rather than a pointer press, so it catches the keyboard-only case too.
  useEffect(() => {
    if (!open) return
    const onFocusIn = (e) => {
      if (isOutside(e.target)) setOpen(false)
    }
    document.addEventListener('focusin', onFocusIn)
    return () => document.removeEventListener('focusin', onFocusIn)
  }, [open, isOutside])

  // Roving focus: move DOM focus onto whichever option is active whenever the
  // menu opens or the active option changes via arrow/Home/End keys.
  useEffect(() => {
    if (!open) return
    optionRefs.current[activeIndex]?.focus()
  }, [open, activeIndex])

  const closeAndReturnFocus = () => {
    setOpen(false)
    triggerRef.current?.focus()
  }

  const openAt = (index) => {
    setActiveIndex(index)
    setOpen(true)
  }

  const onTriggerClick = () => {
    if (open) {
      setOpen(false)
      return
    }
    const selectedIndex = SPEEDS.indexOf(playbackRate)
    openAt(selectedIndex >= 0 ? selectedIndex : 0)
  }

  const onTriggerKeyDown = (e) => {
    if (open) return
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      openAt(0)
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      openAt(SPEEDS.length - 1)
    }
  }

  const onMenuKeyDown = (e) => {
    if (!MENU_HANDLED_KEYS.has(e.key)) return
    e.preventDefault()
    e.stopPropagation()
    switch (e.key) {
      case 'Escape':
        closeAndReturnFocus()
        break
      case 'ArrowDown':
        setActiveIndex((i) => (i + 1) % SPEEDS.length)
        break
      case 'ArrowUp':
        setActiveIndex((i) => (i - 1 + SPEEDS.length) % SPEEDS.length)
        break
      case 'Home':
        setActiveIndex(0)
        break
      case 'End':
        setActiveIndex(SPEEDS.length - 1)
        break
    }
  }

  return (
    <div ref={ref} className="relative">
      <button
        ref={triggerRef}
        type="button"
        onClick={onTriggerClick}
        onKeyDown={onTriggerKeyDown}
        title="Playback speed"
        aria-haspopup="menu"
        aria-expanded={open}
        className="flex items-center gap-1 bg-black/60 text-white rounded-full font-semibold text-[12.5px] px-3 py-1.5 backdrop-blur-sm hover:bg-black/75 active:scale-95 transition-all"
      >
        <span className="material-symbols-outlined text-[16px]">speed</span>
        {playbackRate}×
      </button>
      {open ? (
        <div
          role="menu"
          aria-label="Playback speed"
          onKeyDown={onMenuKeyDown}
          className="absolute right-0 mt-1.5 min-w-[104px] bg-surface border border-line2 rounded-xl shadow-lg py-1 z-20"
        >
          {SPEEDS.map((rate, index) => {
            const selected = rate === playbackRate
            return (
              <button
                key={rate}
                ref={(el) => {
                  optionRefs.current[index] = el
                }}
                type="button"
                role="menuitemradio"
                aria-checked={selected}
                tabIndex={index === activeIndex ? 0 : -1}
                onClick={() => {
                  setRate(rate)
                  closeAndReturnFocus()
                }}
                className={`flex items-center justify-between w-full text-left px-3.5 py-1.5 text-[13px] hover:bg-tint transition-colors ${
                  selected ? 'text-ink font-semibold' : 'text-muted'
                }`}
              >
                {rate === 1 ? 'Normal' : `${rate}×`}
                {selected ? (
                  <span className="material-symbols-outlined text-[16px]">check</span>
                ) : null}
              </button>
            )
          })}
        </div>
      ) : null}
    </div>
  )
}

export default PlaybackSpeed
