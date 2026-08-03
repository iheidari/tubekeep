import { defineConfig, devices } from '@playwright/test'

// A dedicated port so the suite never collides with (or silently reuses) a
// `npm run dev` server already on 5173.
const PORT = 5199

export default defineConfig({
  testDir: './test/a11y',
  testMatch: '**/*.spec.js',
  // Nothing here talks to a backend, a database, or the network (see
  // test/a11y/support/hermetic.js), so the specs are safe to run in parallel.
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['github'], ['list']] : [['list']],
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
  // Chromium only: these assertions are about the app's own CSS cascade and ARIA
  // wiring, not cross-browser rendering differences, so a second engine would
  // double the runtime for no extra signal.
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: `npm run dev -- --port ${PORT} --strictPort`,
    url: `http://localhost:${PORT}`,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
})
