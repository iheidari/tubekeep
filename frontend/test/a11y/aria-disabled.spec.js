import { expect, test } from './support/fixtures.js'

// The repo's rule (CLAUDE.md → Styling system): a button whose inactive state
// carries a user-facing reason uses `aria-disabled` + a click guard, never native
// `disabled` — because `disabled` drops the element from the tab order, so a
// keyboard or screen-reader user would never reach the reason explaining why.
//
// That rule is only worth anything if all three halves hold together, so each
// case below asserts all three: the control is marked aria-disabled, it is still
// keyboard-focusable, and its aria-describedby actually resolves to non-empty
// text. A dangling describedby id is the silent failure mode — the markup looks
// correct and announces nothing.
async function expectInactiveWithReason(page, button, label) {
  await expect(button, `${label} is marked aria-disabled`).toHaveAttribute('aria-disabled', 'true')

  // Read the native `disabled` IDL property directly rather than using
  // toBeEnabled(): Playwright's enabled/disabled matchers follow the
  // *accessibility* notion of disabled, so they count aria-disabled="true" as
  // disabled too — which would make this assertion pass for the very markup it
  // is supposed to reject. The DOM property is the only thing that distinguishes
  // "aria-disabled, still focusable" from "natively disabled, out of tab order".
  const nativelyDisabled = await button.evaluate((el) => el.disabled === true)
  expect(nativelyDisabled, `${label} must not use native disabled`).toBe(false)

  await button.focus()
  await expect(button, `${label} stays keyboard-focusable`).toBeFocused()

  const describedBy = await button.getAttribute('aria-describedby')
  expect(describedBy, `${label} has an aria-describedby`).toBeTruthy()

  for (const id of describedBy.split(/\s+/)) {
    // Attribute selector, not `#id`: React's useId() emits ids containing
    // characters (`«`, `:`) that aren't valid in a bare CSS id selector.
    const reason = page.locator(`[id="${id}"]`)
    await expect(reason, `${label} reason #${id} exists`).toHaveCount(1)
    const text = (await reason.textContent())?.trim()
    expect(text, `${label} reason #${id} announces something`).toBeTruthy()
  }
}

const SIGNED_IN = {
  '**/api/auth/me': {
    status: 200,
    body: { success: true, data: { email: 'tester@example.com', name: 'Tester' } },
  },
}

test.describe('inactive-with-a-reason controls', () => {
  test('UrlInput: the submit button with no URL entered', async ({ page, hermetic }) => {
    await hermetic.prepare({ api: SIGNED_IN })
    await page.goto('/')

    const submit = page.getByRole('button', { name: /get formats/i })
    await expect(submit).toBeVisible()

    await expectInactiveWithReason(page, submit, "UrlInput's submit button")
    await expect(page.getByText('Paste a video URL first')).toHaveCount(1)

    // The click guard: pressing it with an empty field must not navigate away.
    // `force` is required because Playwright's actionability check also treats
    // aria-disabled as disabled and would refuse to dispatch the click at all —
    // exercising the guard means going around that, not honouring it.
    await submit.click({ force: true })
    await expect(page).toHaveURL(/\/$/)
  })

  test('FormatSelector: a format that exceeds the storage quota', async ({ page, hermetic }) => {
    await hermetic.prepare({
      api: {
        ...SIGNED_IN,
        // 4 GB format against 10 MB of remaining quota → downloadBlockReason
        // returns "Over your storage quota".
        '**/api/disk': {
          status: 200,
          body: {
            success: true,
            data: {
              total: 500e9,
              free: 400e9,
              used: 100e9,
              sizeMultiplier: 2,
              headroomBytes: 500e6,
              quota: { used: 90e6, max: 100e6, remaining: 10e6 },
            },
          },
        },
        '**/api/info*': {
          status: 200,
          body: {
            success: true,
            data: {
              title: 'A very large video',
              duration: 600,
              sourceKey: 'youtube:test123',
              formats: {
                video: [
                  {
                    formatId: '137',
                    resolution: '1920x1080',
                    ext: 'mp4',
                    vcodec: 'avc1',
                    filesize: 4e9,
                  },
                ],
                audio: [],
                combined: [],
              },
            },
          },
        },
      },
    })

    await page.goto('/info?url=https%3A%2F%2Fwww.youtube.com%2Fwatch%3Fv%3Dtest123')

    const get = page.getByRole('button', { name: /^Get$/ })
    await expect(get).toBeVisible()

    await expectInactiveWithReason(page, get, "FormatSelector's Get button")
    await expect(page.getByText('Over your storage quota')).toHaveCount(1)
  })

  test('MoveToCloud: a download too close to expiry to move', async ({ page, hermetic }) => {
    // Files expire 1h after creation and a move needs 15 min of runway, so a row
    // created 50 min ago lands in the "expiring soon" branch.
    const createdAt = new Date(Date.now() - 50 * 60 * 1000).toISOString()

    await hermetic.prepare({
      api: {
        ...SIGNED_IN,
        '**/api/files': {
          status: 200,
          body: {
            success: true,
            data: [
              {
                downloadId: 'abc-123',
                title: 'An expiring video',
                filename: 'video.mp4',
                size: 1e6,
                type: 'video',
                url: 'https://www.youtube.com/watch?v=test123',
                createdAt,
                expired: false,
                status: 'complete',
              },
            ],
          },
        },
        // MoveToCloud renders nothing until at least one provider is configured.
        '**/api/cloud/providers': {
          status: 200,
          body: { success: true, data: [{ name: 'dropbox', clientId: 'test-client-id' }] },
        },
      },
    })

    await page.goto('/downloads')

    const move = page.getByRole('button', { name: /move to cloud/i })
    await expect(move).toBeVisible()

    await expectInactiveWithReason(page, move, "MoveToCloud's expiring-soon button")
    await expect(page.getByText('Expiring soon')).toHaveCount(1)
  })
})
