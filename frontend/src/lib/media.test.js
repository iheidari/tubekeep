import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, it } from 'node:test'
import {
  createFailingStorage,
  createStorage,
  installStorage,
  removeStorage,
} from '../../test/helpers/webStorage.js'
import {
  clearStartParams,
  downloadBlockReason,
  fileUrl,
  formatDuration,
  formatFileSize,
  hasQuotaFor,
  hasRoomFor,
  isAudioFile,
  isUnlimitedQuota,
  loadStartParams,
  mediaKind,
  saveStartParams,
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

describe('isAudioFile', () => {
  it('matches the known audio extensions, case-insensitively', () => {
    for (const name of ['a.mp3', 'a.M4A', 'a.ogg', 'a.opus', 'a.wav', 'a.FLAC']) {
      assert.equal(isAudioFile(name), true, name)
    }
  })

  it('is false for video and for nothing at all', () => {
    assert.equal(isAudioFile('clip.mp4'), false)
    assert.equal(isAudioFile(''), false)
    assert.equal(isAudioFile(undefined), false)
  })
})

describe('formatDuration', () => {
  it('formats mm:ss with a zero-padded seconds field', () => {
    assert.equal(formatDuration(0), '0:00')
    assert.equal(formatDuration(65), '1:05')
    assert.equal(formatDuration(3600), '60:00')
  })

  it('floors a fractional second rather than rounding up past 59', () => {
    assert.equal(formatDuration(65.9), '1:05')
    assert.equal(formatDuration(59.9), '0:59')
  })

  it('returns the fallback for a non-finite or negative value', () => {
    assert.equal(formatDuration(undefined), '')
    assert.equal(formatDuration(Number.NaN), '')
    assert.equal(formatDuration(-1), '')
    assert.equal(formatDuration(-1, '--:--'), '--:--')
  })
})

describe('fileUrl', () => {
  it('encodes the filename', () => {
    // Filenames come from yt-dlp and routinely carry spaces, ampersands and
    // unicode; the serve route reads them back RFC 5987-encoded.
    assert.equal(fileUrl('https://h', 'id1', 'a b&c.mp4'), 'https://h/api/files/id1/a%20b%26c.mp4')
    assert.equal(fileUrl('https://h', 'id1', 'café.mp3'), 'https://h/api/files/id1/caf%C3%A9.mp3')
  })

  it('adds the attachment flag only when asked', () => {
    assert.equal(fileUrl('https://h', 'id1', 'v.mp4'), 'https://h/api/files/id1/v.mp4')
    assert.equal(
      fileUrl('https://h', 'id1', 'v.mp4', { download: true }),
      'https://h/api/files/id1/v.mp4?action=download',
    )
  })
})

describe('download start params (sessionStorage)', () => {
  // Per-tab persistence so a reload of /download/:id can resume the SSE instead
  // of losing router state. Pinned here because 0XC-464 will collapse this
  // module's hand-rolled try/catch wrapper into a shared `lib/storage.js`, and
  // that refactor is meant to land against tests holding the degradation
  // behaviour rather than against inspection alone.
  const ID = 'abc-123'
  const PARAMS = { url: 'https://youtu.be/abc', formatId: '137', type: 'video' }
  let store

  beforeEach(() => {
    store = installStorage('sessionStorage', createStorage())
  })

  afterEach(() => {
    removeStorage('sessionStorage')
  })

  it('round-trips the params for a download', () => {
    saveStartParams(ID, PARAMS)
    assert.deepEqual(loadStartParams(ID), PARAMS)
  })

  it('namespaces them by downloadId', () => {
    saveStartParams(ID, PARAMS)
    assert.equal(loadStartParams('a-different-id'), null)
    assert.equal(store.length, 1)
  })

  it('reads an absent key as null', () => {
    assert.equal(loadStartParams(ID), null)
  })

  it('reads corrupt JSON as null rather than throwing', () => {
    saveStartParams(ID, PARAMS)
    store.setItem(store.key(0), '{ not json')
    assert.equal(loadStartParams(ID), null)
  })

  it('clears them', () => {
    saveStartParams(ID, PARAMS)
    clearStartParams(ID)
    assert.equal(loadStartParams(ID), null)
    assert.equal(store.length, 0)
  })

  it('stays inert when sessionStorage throws', () => {
    installStorage('sessionStorage', createFailingStorage())
    assert.doesNotThrow(() => saveStartParams(ID, PARAMS))
    assert.doesNotThrow(() => clearStartParams(ID))
    assert.equal(loadStartParams(ID), null)
  })

  it('stays inert when sessionStorage is absent', () => {
    removeStorage('sessionStorage')
    assert.doesNotThrow(() => saveStartParams(ID, PARAMS))
    assert.doesNotThrow(() => clearStartParams(ID))
    assert.equal(loadStartParams(ID), null)
  })
})
