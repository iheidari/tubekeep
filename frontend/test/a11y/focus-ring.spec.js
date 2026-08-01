import { expect, test } from '@playwright/test'
import { preparePage } from './support/hermetic.js'
import { expectNoVisibleRing, expectVisibleRing, readRing } from './support/ring.js'

// The global focus ring, checked in a real browser.
//
// Why this file exists: the ring shipped invisible on every text input in the app
// and lint, `vite build` and the whole backend suite were green anyway (0XC-111 /
// PR #32). Nothing in CI rendered a page, so a CSS specificity conflict between
// the app's own <style> block and the Tailwind forms plugin was unobservable
// until a human tabbed through the UI. These assertions are that missing gate.

test.describe('global focus ring', () => {
  test('is visible on every focusable control on /login', async ({ page }) => {
    await preparePage(page)
    await page.goto('/login')

    // The form, not the loading spinner — /api/auth/me is stubbed 401 (signed out).
    const email = page.getByLabel('Email address')
    await expect(email).toBeVisible()

    // Walk the real tab order rather than a hand-listed set of selectors, so a
    // control added to this page is covered the day it lands.
    const seen = []
    for (let i = 0; i < 10; i++) {
      await page.keyboard.press('Tab')
      const focused = page.locator(':focus')
      if ((await focused.count()) === 0) break

      const id = await focused.evaluate((el) => {
        const name = el.getAttribute('aria-label') || el.textContent?.trim() || el.id
        return `${el.tagName.toLowerCase()}${el.type ? `[type=${el.type}]` : ''} "${name}"`
      })
      if (seen.includes(id)) break // wrapped past the last control
      seen.push(id)

      await expectVisibleRing(focused, `${id} on /login`)
    }

    // Guards against the loop above silently covering nothing: /login has a logo
    // link, the email input and the submit button.
    expect(seen.length, `tab order walked: ${seen.join(', ')}`).toBeGreaterThanOrEqual(3)
    expect(seen.some((s) => s.includes('input[type=email]'))).toBe(true)
  })

  test('a mouse click draws no ring (:focus-visible must not fire on pointer input)', async ({
    page,
  }) => {
    await preparePage(page)
    await page.goto('/login')

    const submit = page.getByRole('button', { name: 'Send sign-in link' })
    await submit.click()

    await expect(submit).toBeFocused()
    await expectNoVisibleRing(submit, 'submit button after a mouse click')
  })

  // A text input is deliberately not used for the click case: per the CSS UI
  // spec, :focus-visible always matches an element that takes text input,
  // whatever the modality — so a clicked input showing a ring is correct.

  for (const theme of ['light', 'dark']) {
    test(`--focus-ring resolves and colours the ring in ${theme} mode`, async ({ page }) => {
      await preparePage(page, { theme })
      await page.goto('/login')

      const email = page.getByLabel('Email address')
      await expect(email).toBeVisible()

      await expect(page.locator('html')).toHaveClass(new RegExp(`\\b${theme}\\b`))

      const token = await page.evaluate(() =>
        getComputedStyle(document.documentElement).getPropertyValue('--focus-ring').trim(),
      )
      expect(token, `--focus-ring must resolve in ${theme} mode`).toMatch(/^\d+ \d+ \d+$/)

      await email.focus()
      await expectVisibleRing(email, `email input in ${theme} mode`)

      // Compare against the token rather than a hard-coded colour, so retuning
      // the palette doesn't need a test edit — only dropping the wiring does.
      const ring = await readRing(email)
      const [r, g, b] = token.split(/\s+/)
      expect(ring.color.replace(/\s/g, '')).toBe(`rgb(${r},${g},${b})`)
    })
  }

  test('nothing reached the network beyond localhost', async ({ page }) => {
    const hermetic = await preparePage(page)
    await page.goto('/login')
    await expect(page.getByLabel('Email address')).toBeVisible()

    expect(hermetic.violations, 'requests that escaped the hermetic boundary').toEqual([])
  })
})

// The regression guard. Everything above passes trivially if the forms plugin's
// competing rule isn't actually in the page — so prove it is, by reproducing the
// exact defect in the browser and checking the assertions go red.
//
// This automates the acceptance criterion "the assertions fail when the `:root`
// prefix is removed", which would otherwise only ever be verified by hand once.
test('the ring assertions fail when the `:root` prefix is removed', async ({ page }) => {
  await preparePage(page)
  await page.goto('/login')

  const email = page.getByLabel('Email address')
  await expect(email).toBeVisible()

  // Healthy first, so a failure here points at the fix rather than the guard.
  await email.focus()
  await expectVisibleRing(email, 'email input before reverting the fix')

  // Re-run the app's own focus rule at the specificity it had before ad9b90d:
  // `input:focus-visible` (0,1,1) instead of `:root input:focus-visible` (0,2,1).
  const stripped = await page.evaluate(() => {
    const style = [...document.querySelectorAll('style')].find((s) =>
      s.textContent.includes(':root input:focus-visible'),
    )
    if (!style) return 0
    const before = style.textContent
    style.textContent = before.replaceAll(':root ', '')
    return before.split(':root ').length - 1
  })

  // If the rule is ever renamed or moved, fail loudly here instead of quietly
  // asserting nothing.
  expect(stripped, "expected to find the `:root`-prefixed focus rule in index.html's <style>").toBe(
    5,
  )

  // The forms plugin's `[type="email"]:focus { outline: 2px solid transparent }`
  // at (0,2,0) now out-ranks it, and the ring goes invisible — geometry intact,
  // colour zeroed. That is exactly the bug this suite exists to catch.
  await email.blur()
  await email.focus()
  await expectNoVisibleRing(email, 'email input with the `:root` prefix removed')

  const ring = await readRing(email)
  expect(ring.style, 'the defect leaves the geometry looking healthy').toBe('solid')
  expect(ring.alpha, 'only the colour is zeroed — which is why this was invisible').toBe(0)
})
