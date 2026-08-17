import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  downloadBlockReason,
  formatFileSize,
  hasQuotaFor,
  hasRoomFor,
  isUnlimitedQuota,
  mediaKind,
  sharesSource,
} from './media.js'

// The backend owns the fit knobs and echoes them in GET /api/disk; these are the
// values `backend/src/utils/storage.js` ships today, restated so a case reads as
// a boundary. The client reads them off the response rather than hardcoding
// them, which is what keeps the two sides from drifting — so a change there is
// meant to reach the UI without touching this file.
const MULTIPLIER = 2
const HEADROOM = 500 * 1024 * 1024

const ONE_GB = 1024 ** 3

// Only the fields each guard actually reads, so a case can't pass by accident on
// a field the predicate ignores.
const diskFitting = (free) => ({ free, sizeMultiplier: MULTIPLIER, headroomBytes: HEADROOM })
const quotaOf = (remaining) => ({ quota: { remaining } })

describe('sharesSource', () => {
  // The client half of the re-download dedupe rule (0XC-117). The server's
  // version is `sharesSource` / `SUPERSEDABLE_SQL` in
  // `backend/src/services/downloadsStore.js` — canonical extractor id when BOTH
  // sides carry one, else exact URL equality. Keep the two in step: this one
  // drives HistoryContext's supersede mirror and InfoPage's "you already have
  // this" warning, and disagreeing with the server means the UI claims a
  // download was replaced when it wasn't, or vice versa.
  it('matches on sourceKey when both sides carry one, whatever the urls', () => {
    const a = { sourceKey: 'youtube:abc', url: 'https://youtu.be/abc?t=30' }
    const b = { sourceKey: 'youtube:abc', url: 'https://www.youtube.com/watch?v=abc&si=x' }
    assert.equal(sharesSource(a, b), true)
  })

  it('does not match differing sourceKeys even when the urls are identical', () => {
    const url = 'https://example.com/same'
    assert.equal(
      sharesSource({ sourceKey: 'youtube:a', url }, { sourceKey: 'youtube:b', url }),
      false,
    )
  })

  it('falls back to exact url equality when either side lacks a sourceKey', () => {
    const url = 'https://youtu.be/abc'
    assert.equal(sharesSource({ url }, { url }), true)
    assert.equal(sharesSource({ sourceKey: 'youtube:abc', url }, { url }), true)
    assert.equal(sharesSource({ url }, { sourceKey: 'youtube:abc', url }), true)
  })

  it('treats a differing url as a different video on the fallback path', () => {
    assert.equal(
      sharesSource({ url: 'https://youtu.be/abc' }, { url: 'https://youtu.be/xyz' }),
      false,
    )
  })

  it('is false when a url is missing on the fallback path', () => {
    // Two rows that each know nothing must not collapse into "the same video".
    assert.equal(sharesSource({}, {}), false)
    assert.equal(sharesSource({ url: undefined }, { url: undefined }), false)
  })

  it('is false for a missing record on either side', () => {
    assert.equal(sharesSource(null, { url: 'x' }), false)
    assert.equal(sharesSource({ url: 'x' }, undefined), false)
  })
})

describe('hasRoomFor', () => {
  // Mirrors the backend's `hasRoomFor(free, filesize)` in
  // `backend/src/utils/storage.js`: free >= filesize * DISK_SIZE_MULTIPLIER +
  // DISK_HEADROOM_BYTES. The 2x covers the transient video+audio merge. This is
  // a UX guard only — POST /api/download re-checks it server-side.
  it('fits at exactly the required margin', () => {
    const required = ONE_GB * MULTIPLIER + HEADROOM
    assert.equal(hasRoomFor(ONE_GB, diskFitting(required)), true)
  })

  it('does not fit one byte under the margin', () => {
    const required = ONE_GB * MULTIPLIER + HEADROOM
    assert.equal(hasRoomFor(ONE_GB, diskFitting(required - 1)), false)
  })

  it('never blocks an unknown or zero size', () => {
    assert.equal(hasRoomFor(0, diskFitting(0)), true)
    assert.equal(hasRoomFor(undefined, diskFitting(0)), true)
    assert.equal(hasRoomFor(null, diskFitting(0)), true)
  })

  it('never blocks before the disk response has landed', () => {
    assert.equal(hasRoomFor(ONE_GB, null), true)
    assert.equal(hasRoomFor(ONE_GB, undefined), true)
  })
})

describe('hasQuotaFor', () => {
  // Mirrors the backend's per-user quota guard in
  // `backend/src/utils/storage.js` (`hasQuotaFor` / `remainingQuota`), but
  // consumes `quota.remaining` rather than re-deriving it from used/max — the
  // server already encodes both the subtraction and the clamp-at-zero, so
  // "how much is left" has one definition. No multiplier or headroom here: the
  // quota counts what a download keeps, not its merge footprint.
  it('fits at exactly the remaining allowance', () => {
    assert.equal(hasQuotaFor(ONE_GB, quotaOf(ONE_GB)), true)
  })

  it('does not fit one byte over the remaining allowance', () => {
    assert.equal(hasQuotaFor(ONE_GB + 1, quotaOf(ONE_GB)), false)
  })

  it('blocks everything once the allowance is spent', () => {
    // remainingQuota clamps at 0 server-side, so an over-quota user reads as 0.
    assert.equal(hasQuotaFor(1, quotaOf(0)), false)
  })

  it('treats the -1 sentinel as unlimited', () => {
    assert.equal(hasQuotaFor(Number.MAX_SAFE_INTEGER, quotaOf(-1)), true)
  })

  it('fails open on a missing or garbled allowance', () => {
    // A UX guard must not block a download because the number was unreadable —
    // the server backstop is what actually enforces the cap.
    assert.equal(hasQuotaFor(ONE_GB, quotaOf(undefined)), true)
    assert.equal(hasQuotaFor(ONE_GB, quotaOf('not a number')), true)
    assert.equal(hasQuotaFor(ONE_GB, {}), true)
    assert.equal(hasQuotaFor(ONE_GB, null), true)
  })

  it('never blocks an unknown or zero size', () => {
    assert.equal(hasQuotaFor(0, quotaOf(0)), true)
    assert.equal(hasQuotaFor(undefined, quotaOf(0)), true)
  })
})

describe('isUnlimitedQuota', () => {
  it('is true for the -1 sentinel and any unreadable value', () => {
    for (const value of [-1, -5, undefined, Number.NaN, 'nope']) {
      assert.equal(isUnlimitedQuota(value), true, `${String(value)} reads as unlimited`)
    }
  })

  it('is false for a real allowance, including zero', () => {
    assert.equal(isUnlimitedQuota(0), false)
    assert.equal(isUnlimitedQuota(ONE_GB), false)
  })

  it('reads null as a zero allowance, not as unlimited', () => {
    // Number(null) is 0, so null is the one "empty" value that does NOT fail
    // open — it blocks every download instead. Pinned rather than fixed because
    // the backend's isUnlimitedQuota coerces identically (`Number(max)` in
    // `backend/src/utils/storage.js`), and the two must agree; it is also
    // unreachable in practice, since `quota.remaining` is produced by the
    // server's remainingQuota(), which returns a number or the -1 sentinel.
    assert.equal(isUnlimitedQuota(null), false)
    assert.equal(hasQuotaFor(1, quotaOf(null)), false)
  })
})

describe('downloadBlockReason', () => {
  const roomy = { ...diskFitting(Number.MAX_SAFE_INTEGER), ...quotaOf(-1) }

  it('returns null when both guards pass', () => {
    assert.equal(downloadBlockReason(ONE_GB, roomy), null)
  })

  it('reports the quota when only the quota is exceeded', () => {
    const disk = { ...diskFitting(Number.MAX_SAFE_INTEGER), ...quotaOf(1) }
    assert.equal(downloadBlockReason(ONE_GB, disk), 'Over your storage quota')
  })

  it('reports disk space when only the disk is short', () => {
    const disk = { ...diskFitting(1), ...quotaOf(-1) }
    assert.equal(downloadBlockReason(ONE_GB, disk), 'Not enough space')
  })

  it('prefers the quota reason when both fail', () => {
    // The quota is the one the user can act on themselves, so it wins.
    const disk = { ...diskFitting(1), ...quotaOf(1) }
    assert.equal(downloadBlockReason(ONE_GB, disk), 'Over your storage quota')
  })

  it('never blocks a format of unknown size', () => {
    const disk = { ...diskFitting(1), ...quotaOf(1) }
    assert.equal(downloadBlockReason(undefined, disk), null)
  })
})

describe('mediaKind', () => {
  it('prefers the explicit type yt-dlp gave us', () => {
    assert.equal(mediaKind({ type: 'audio', filename: 'x.mp4' }), 'audio')
    assert.equal(mediaKind({ type: 'video', filename: 'x.mp3' }), 'video')
    assert.equal(mediaKind({ type: 'combined', filename: 'x.mp3' }), 'video')
  })

  it('falls back to the filename extension', () => {
    assert.equal(mediaKind({ filename: 'song.mp3' }), 'audio')
    assert.equal(mediaKind({ filename: 'song.FLAC' }), 'audio')
    assert.equal(mediaKind({ filename: 'clip.mp4' }), 'video')
  })

  it('defaults to video when it knows nothing', () => {
    assert.equal(mediaKind({}), 'video')
    assert.equal(mediaKind(null), 'video')
  })
})

describe('formatFileSize', () => {
  it('reads an absent size as unknown', () => {
    assert.equal(formatFileSize(0), 'Unknown')
    assert.equal(formatFileSize(undefined), 'Unknown')
  })

  it('formats within the table', () => {
    assert.equal(formatFileSize(1024), '1.00 KB')
    assert.equal(formatFileSize(1024 ** 3), '1.00 GB')
  })

  it('clamps the unit index rather than running off the end of the table', () => {
    // The disk banner feeds whole-disk sizes, so a value past the last unit must
    // still render — an unclamped index yields "undefined" as the unit.
    const huge = formatFileSize(1024 ** 7)
    assert.ok(huge.endsWith(' PB'), `expected a PB-suffixed size, got ${huge}`)
    assert.ok(!huge.includes('undefined'))
  })
})
