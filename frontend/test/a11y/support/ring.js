import { expect } from '@playwright/test'

// Minimum ring geometry the app promises (WCAG 2.4.11 Focus Appearance): a solid
// outline at least 2px thick, offset 2px off the control so it reads against both
// a plain surface and a filled (bg-fill) one.
export const RING = { minWidth: 2, offset: 2 }

// Parse a computed colour (`rgb(26, 20, 17)` / `rgba(0, 0, 0, 0)`) into channels.
// Returns alpha 0 for the transparent keyword, which is what the forms plugin's
// reset resolves to and therefore the single most important case here.
function parseColor(value) {
  if (!value || value === 'transparent') return { r: 0, g: 0, b: 0, a: 0 }
  const nums = value.match(/[\d.]+/g)
  if (!nums || nums.length < 3) return { r: 0, g: 0, b: 0, a: 0 }
  const [r, g, b, a] = nums.map(Number)
  return { r, g, b, a: a === undefined ? 1 : a }
}

// Read the outline the browser is actually painting on an element.
async function readRing(locator) {
  const raw = await locator.evaluate((el) => {
    const s = getComputedStyle(el)
    return {
      style: s.outlineStyle,
      width: s.outlineWidth,
      offset: s.outlineOffset,
      color: s.outlineColor,
    }
  })
  return {
    style: raw.style,
    width: Number.parseFloat(raw.width) || 0,
    offset: Number.parseFloat(raw.offset) || 0,
    color: raw.color,
    alpha: parseColor(raw.color).a,
  }
}

// True when the element is painting a ring a sighted user can actually see.
// The alpha check is the one that catches this bug class: the forms plugin's
// reset leaves outline-style `solid` and outline-width `2px` intact and only
// zeroes the colour, so geometry alone reads as a perfectly healthy ring.
const isVisibleRing = (ring) =>
  ring.style === 'solid' && ring.width >= RING.minWidth && ring.alpha > 0

// Assert a visible focus ring, polling until it settles.
//
// Controls in this app carry Tailwind's `transition-all`, which animates
// outline-color/width/offset over ~150ms — reading immediately after focus()
// returns the t=0 frame and fails confusingly. expect.poll re-reads until the
// animation lands (or the timeout expires), so the assertion describes the
// resting state rather than whichever frame it happened to catch.
export async function expectVisibleRing(locator, label) {
  await expect
    .poll(
      async () => {
        const ring = await readRing(locator)
        return isVisibleRing(ring) && ring.offset === RING.offset
      },
      { message: `${label} should paint a visible focus ring`, timeout: 3000 },
    )
    .toBe(true)

  // Re-read once settled and assert each property separately, so a failure names
  // which part of the ring is wrong instead of just "expected true".
  const ring = await readRing(locator)
  expect(ring.style, `${label} outline-style`).toBe('solid')
  expect(ring.width, `${label} outline-width`).toBeGreaterThanOrEqual(RING.minWidth)
  expect(ring.offset, `${label} outline-offset`).toBe(RING.offset)
  expect(
    ring.alpha,
    `${label} outline-color must not be transparent (got ${ring.color})`,
  ).toBeGreaterThan(0)
}

// Assert the element is NOT painting a ring — used for the pointer-input case,
// where :focus-visible must stay off.
export async function expectNoVisibleRing(locator, label) {
  await expect
    .poll(async () => isVisibleRing(await readRing(locator)), {
      message: `${label} should not paint a focus ring`,
      timeout: 3000,
    })
    .toBe(false)
}

export { isVisibleRing, readRing }
