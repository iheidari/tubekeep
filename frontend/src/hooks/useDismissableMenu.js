import { useCallback, useEffect, useId, useRef, useState } from 'react'

const MENU_HANDLED_KEYS = new Set(['Escape', 'ArrowDown', 'ArrowUp', 'Home', 'End'])

// Dismissal + roving-focus behavior shared by every trigger-button/menu pair
// (PlaybackSpeed, MoveToCloud's provider picker, …). Owns open/close state,
// pointerdown-outside and focusin-tab-out dismissal, Escape-closes-with-focus-return,
// and Arrow/Home/End roving focus over `itemCount` items. Roles, labels, and
// selection semantics stay with the caller — this hook only knows "how many
// items" and "which one is active".
export function useDismissableMenu(itemCount) {
  const [open, setOpen] = useState(false)
  const [activeIndex, setActiveIndex] = useState(0)
  const rootRef = useRef(null)
  const triggerRef = useRef(null)
  const itemRefs = useRef([])
  const menuId = useId()

  // Shared by both outside-interaction effects below.
  const isOutside = useCallback(
    (target) => rootRef.current && !rootRef.current.contains(target),
    [],
  )

  // Closes on outside pointerdown, and on focus moving outside — the latter
  // covers tabbing/shift-tabbing out of the trigger+menu group, which a
  // pointerdown listener alone would miss (no pointer press involved), and
  // which would otherwise leave the panel (and its stale aria-expanded="true")
  // on screen after focus has moved elsewhere.
  useEffect(() => {
    if (!open) return
    const onOutsideInteraction = (e) => {
      if (isOutside(e.target)) setOpen(false)
    }
    document.addEventListener('pointerdown', onOutsideInteraction)
    document.addEventListener('focusin', onOutsideInteraction)
    return () => {
      document.removeEventListener('pointerdown', onOutsideInteraction)
      document.removeEventListener('focusin', onOutsideInteraction)
    }
  }, [open, isOutside])

  // Roving focus: move DOM focus onto whichever item is active whenever the
  // menu opens or the active item changes via arrow/Home/End keys.
  useEffect(() => {
    if (!open) return
    itemRefs.current[activeIndex]?.focus()
  }, [open, activeIndex])

  const closeAndReturnFocus = useCallback(() => {
    setOpen(false)
    triggerRef.current?.focus()
  }, [])

  const openAt = useCallback((index) => {
    setActiveIndex(index)
    setOpen(true)
  }, [])

  const onTriggerKeyDown = useCallback(
    (e) => {
      if (open) return
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        openAt(0)
      } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        openAt(itemCount - 1)
      }
    },
    [open, openAt, itemCount],
  )

  const onMenuKeyDown = useCallback(
    (e) => {
      if (!MENU_HANDLED_KEYS.has(e.key)) return
      e.preventDefault()
      e.stopPropagation()
      switch (e.key) {
        case 'Escape':
          closeAndReturnFocus()
          break
        case 'ArrowDown':
          setActiveIndex((i) => (i + 1) % itemCount)
          break
        case 'ArrowUp':
          setActiveIndex((i) => (i - 1 + itemCount) % itemCount)
          break
        case 'Home':
          setActiveIndex(0)
          break
        case 'End':
          setActiveIndex(itemCount - 1)
          break
      }
    },
    [itemCount, closeAndReturnFocus],
  )

  // Spread onto each menu item: wires up the roving-focus ref and tabIndex.
  const getItemProps = useCallback(
    (index) => ({
      ref: (el) => {
        itemRefs.current[index] = el
      },
      tabIndex: index === activeIndex ? 0 : -1,
    }),
    [activeIndex],
  )

  return {
    open,
    rootRef,
    triggerRef,
    menuId,
    openAt,
    closeAndReturnFocus,
    onTriggerKeyDown,
    onMenuKeyDown,
    getItemProps,
  }
}
