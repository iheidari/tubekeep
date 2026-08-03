import { test as base, expect } from '@playwright/test'
import { preparePage } from './hermetic.js'

// The suite's `test`, extended with an auto-used `hermetic` fixture.
//
// The fixture exists so hermeticity is a property of every test rather than the
// job of one test that remembers to check. Setup is explicit (each test picks its
// own theme and API stubs), but the teardown assertion is not opt-in: any request
// that escaped to a non-localhost host fails the test that made it, and names it.
export const test = base.extend({
  hermetic: async ({ page }, use) => {
    let boundary = null

    const handle = {
      // Install the network boundary + API stubs. Call this before page.goto().
      prepare: async (options) => {
        boundary = await preparePage(page, options)
        return boundary
      },
    }

    await use(handle)

    // A test that never called prepare() had no boundary installed, which would
    // silently make this assertion vacuous — surface that instead.
    expect(boundary, 'test must call hermetic.prepare() before navigating').not.toBeNull()
    expect(boundary.violations, 'requests that escaped the hermetic boundary').toEqual([])
  },
})

export { expect }
