import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const TAILWIND_CDN_STUB = readFileSync(join(here, '../../fixtures/tailwind-cdn-stub.js'), 'utf8')

// Hosts the app's index.html reaches for at runtime. Each is answered locally so
// the suite never opens a socket to the internet — see the module comment below.
const TAILWIND_CDN = 'cdn.tailwindcss.com'
const GOOGLE_FONTS = ['fonts.googleapis.com', 'fonts.gstatic.com']

const isLocal = (host) => host === 'localhost' || host === '127.0.0.1' || host === '[::1]'

// Install the hermetic network boundary on a page.
//
// "Hermetic" here is enforced, not asserted: every request the page makes is
// intercepted, and anything that isn't localhost or one of the two known
// third-party hosts below is ABORTED and recorded. The returned handle exposes
// `violations` so a test can prove nothing escaped.
//
// The two third-party hosts are answered from local fixtures rather than blocked
// outright, because index.html loads Tailwind (and its forms plugin) from a CDN
// at runtime — and the forms plugin's `:focus` reset is precisely the rule the
// focus-ring assertions must out-rank. Blocking it would leave the suite green
// against a reverted fix. See fixtures/tailwind-cdn-stub.js.
export async function installHermetic(page) {
  const violations = []

  await page.route('**/*', async (route) => {
    const url = new URL(route.request().url())

    if (url.hostname === TAILWIND_CDN) {
      return route.fulfill({
        status: 200,
        contentType: 'application/javascript',
        body: TAILWIND_CDN_STUB,
      })
    }

    // Webfonts are irrelevant to every assertion here (outline geometry, colour,
    // ARIA wiring), so an empty stylesheet is a faithful enough stand-in.
    if (GOOGLE_FONTS.includes(url.hostname)) {
      return route.fulfill({ status: 200, contentType: 'text/css', body: '' })
    }

    if (isLocal(url.hostname)) return route.continue()

    violations.push(url.href)
    return route.abort()
  })

  return { violations }
}

// Answer the API calls the app makes on boot, so no backend (and no database, no
// yt-dlp) has to exist for the suite to run. Routes registered here take priority
// over the catch-all above because Playwright matches most-recently-added first.
//
// `overrides` maps a URL glob to a JSON payload, letting a test swap in the state
// it needs (e.g. a signed-in user) without restating the defaults.
export async function mockApi(page, overrides = {}) {
  const routes = {
    // Signed out by default: /login renders its form rather than redirecting.
    '**/api/auth/me': { status: 401, body: { success: false, error: 'unauthorized' } },
    '**/api/files': { status: 200, body: { success: true, data: [] } },
    '**/api/cloud/providers': { status: 200, body: { success: true, data: [] } },
    ...overrides,
  }

  for (const [glob, response] of Object.entries(routes)) {
    await page.route(glob, (route) =>
      route.fulfill({
        status: response.status ?? 200,
        contentType: 'application/json',
        body: JSON.stringify(response.body),
      }),
    )
  }
}

// Every setup step a page needs before navigating: network boundary, API stubs,
// and the colour theme (applied through the app's real localStorage key so the
// no-FOUC script in index.html picks it up before first paint).
export async function preparePage(page, { theme = 'light', api = {} } = {}) {
  const hermetic = await installHermetic(page)
  await mockApi(page, api)
  await page.addInitScript((value) => {
    window.localStorage.setItem('tubekeepTheme', value)
  }, theme)
  return hermetic
}
