import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, it } from 'node:test'
import {
  createFailingStorage,
  createStorage,
  installStorage,
  removeStorage,
} from '../../test/helpers/webStorage.js'
import { clearPosition, positionToSeek, savePosition } from './resume.js'

// The thresholds resume.js encodes. Deliberately restated rather than imported —
// the module keeps them private, and a case that re-derived its expectation from
// the same constant would keep passing through any change to it. If one of these
// goes red, the module moved a threshold and this file is the record of what it
// used to be.
const MIN_POSITION_SECONDS = 10
const MIN_TAIL_SECONDS = 15
const MAX_LATE_SEEK_SECONDS = 10
const MAX_ENTRIES = 50

const EMAIL = 'viewer@example.com'
const TRACK = { downloadId: 'd1' }
const DURATION = 600
// Comfortably inside both bounds, for the cases that are about something else.
const OK_TIME = 300
// A cold start: the read-side decision only applies before the viewer is
// genuinely watching.
const FRESH = { duration: DURATION, currentTime: 0 }

let storage

beforeEach(() => {
  storage = installStorage('localStorage', createStorage())
})

afterEach(() => {
  removeStorage('localStorage')
})

// resume.js hashes the identity into its storage key. Write one entry through
// the public API and read the key back, rather than restating the hash here — a
// copy would keep passing even if the real one changed.
function storageKeyFor(email) {
  savePosition(email, { downloadId: '__probe__' }, OK_TIME, DURATION)
  const key = storage.key(0)
  storage.clear()
  return key
}

describe('isResumable boundaries', () => {
  it('does not record a position at exactly MIN_POSITION_SECONDS', () => {
    savePosition(EMAIL, TRACK, MIN_POSITION_SECONDS, DURATION)
    assert.equal(positionToSeek(EMAIL, TRACK, FRESH), null)
  })

  it('records a position just past MIN_POSITION_SECONDS', () => {
    const time = MIN_POSITION_SECONDS + 0.5
    savePosition(EMAIL, TRACK, time, DURATION)
    assert.equal(positionToSeek(EMAIL, TRACK, FRESH), time)
  })

  it('records a position exactly MIN_TAIL_SECONDS from the end', () => {
    const time = DURATION - MIN_TAIL_SECONDS
    savePosition(EMAIL, TRACK, time, DURATION)
    assert.equal(positionToSeek(EMAIL, TRACK, FRESH), time)
  })

  it('does not record a position inside the tail guard', () => {
    // Resuming here would end playback instantly and force a scrub back — the
    // worst outcome the feature can produce.
    savePosition(EMAIL, TRACK, DURATION - MIN_TAIL_SECONDS + 0.5, DURATION)
    assert.equal(positionToSeek(EMAIL, TRACK, FRESH), null)
  })

  it('records nothing for a non-finite time or a duration of zero', () => {
    savePosition(EMAIL, TRACK, Number.NaN, DURATION)
    savePosition(EMAIL, TRACK, OK_TIME, Number.NaN)
    savePosition(EMAIL, TRACK, OK_TIME, 0)
    assert.equal(storage.length, 0)
  })
})

describe('the read side', () => {
  it('rejects a stored position that is not tail-safe for THIS file', () => {
    // The same key can front two different files — a 600s copy expired, a 590s
    // one re-downloaded. A position that isn't MIN_TAIL_SECONDS short of the
    // file actually playing is refused outright rather than clamped.
    savePosition(EMAIL, TRACK, DURATION - MIN_TAIL_SECONDS, DURATION)
    assert.equal(positionToSeek(EMAIL, TRACK, { duration: DURATION - 10, currentTime: 0 }), null)
  })

  it('declines to seek once the viewer is genuinely watching', () => {
    savePosition(EMAIL, TRACK, OK_TIME, DURATION)
    const late = { duration: DURATION, currentTime: MAX_LATE_SEEK_SECONDS }
    assert.equal(positionToSeek(EMAIL, TRACK, late), null)
  })

  it('still seeks just inside the late-seek window', () => {
    savePosition(EMAIL, TRACK, OK_TIME, DURATION)
    const barelyInTime = { duration: DURATION, currentTime: MAX_LATE_SEEK_SECONDS - 0.01 }
    assert.equal(positionToSeek(EMAIL, TRACK, barelyInTime), OK_TIME)
  })

  it('declines to seek when currentTime is unknown (NaN)', () => {
    // The predicate is negated — `!(currentTime < MAX)` — precisely so NaN,
    // which compares false against everything, declines. Spelled as `>=` it
    // would seek on an unknown currentTime and yank a watching viewer back.
    savePosition(EMAIL, TRACK, OK_TIME, DURATION)
    assert.equal(
      positionToSeek(EMAIL, TRACK, { duration: DURATION, currentTime: Number.NaN }),
      null,
    )
  })
})

describe('which key a track is filed under', () => {
  it('prefers sourceKey, so a re-download keeps its place', () => {
    savePosition(EMAIL, { sourceKey: 'youtube:abc', downloadId: 'old' }, OK_TIME, DURATION)
    const redownloaded = { sourceKey: 'youtube:abc', downloadId: 'new' }
    assert.equal(positionToSeek(EMAIL, redownloaded, FRESH), OK_TIME)
  })

  it('falls back to downloadId when there is no sourceKey', () => {
    savePosition(EMAIL, { downloadId: 'd1' }, OK_TIME, DURATION)
    assert.equal(positionToSeek(EMAIL, { downloadId: 'd1' }, FRESH), OK_TIME)
    assert.equal(positionToSeek(EMAIL, { downloadId: 'd2' }, FRESH), null)
  })

  it('is a no-op for a track carrying neither', () => {
    assert.doesNotThrow(() => savePosition(EMAIL, {}, OK_TIME, DURATION))
    assert.equal(storage.length, 0)
    assert.equal(positionToSeek(EMAIL, {}, FRESH), null)
    assert.equal(positionToSeek(EMAIL, null, FRESH), null)
  })

  it('files positions per identity', () => {
    savePosition('a@example.com', TRACK, OK_TIME, DURATION)
    assert.equal(positionToSeek('a@example.com', TRACK, FRESH), OK_TIME)
    assert.equal(positionToSeek('b@example.com', TRACK, FRESH), null)
    assert.equal(positionToSeek(null, TRACK, FRESH), null, 'anon is its own namespace')
  })
})

describe('clearPosition', () => {
  it('forgets a stored position', () => {
    savePosition(EMAIL, TRACK, OK_TIME, DURATION)
    clearPosition(EMAIL, TRACK)
    assert.equal(positionToSeek(EMAIL, TRACK, FRESH), null)
  })

  it('does not write when there is nothing to clear', () => {
    clearPosition(EMAIL, TRACK)
    assert.equal(storage.length, 0)
  })
})

describe('the LRU prune', () => {
  it('keeps the MAX_ENTRIES most recently updated entries and drops malformed ones', () => {
    const key = storageKeyFor(EMAIL)
    const seeded = {}
    // Distinct, ascending `u` values. Entries written through savePosition in
    // one millisecond would share a timestamp, and since Array#sort is stable
    // the case would then be asserting insertion order rather than recency.
    for (let i = 0; i <= MAX_ENTRIES; i++) seeded[`v${i}`] = { t: 60, u: 1000 + i }
    seeded.badT = { t: 'not a number', u: 5000 }
    seeded.badU = { t: 60 }
    seeded.badNull = null
    storage.setItem(key, JSON.stringify(seeded))

    savePosition(EMAIL, { downloadId: 'fresh' }, OK_TIME, DURATION)

    const stored = JSON.parse(storage.dump()[key])
    assert.equal(Object.keys(stored).length, MAX_ENTRIES)
    // `fresh` is stamped with Date.now(), so it outranks every seeded entry.
    assert.ok('fresh' in stored, 'the entry that triggered the prune survives it')
    assert.ok(`v${MAX_ENTRIES}` in stored, 'the newest seeded entry survives')
    // 51 seeded + 1 fresh = 52 valid candidates for 50 slots, so the two oldest go.
    assert.ok(!('v0' in stored), 'the oldest entry is evicted')
    assert.ok(!('v1' in stored), 'the second-oldest entry is evicted')
    for (const bad of ['badT', 'badU', 'badNull']) {
      assert.ok(!(bad in stored), `${bad} is dropped as malformed`)
    }
  })
})

describe('corrupt or hostile stored JSON', () => {
  const CORRUPT = [
    ['unparseable text', '{ not json'],
    ['a JSON null', 'null'],
    ['a JSON string', '"nope"'],
    ['a JSON number', '42'],
    ['a JSON boolean', 'true'],
    // An array survives the `typeof === 'object'` guard, so it is here to assert
    // the outcome is inert rather than that the guard rejects it.
    ['a JSON array', '[1,2,3]'],
  ]

  for (const [label, raw] of CORRUPT) {
    it(`reads ${label} as no stored position`, () => {
      const key = storageKeyFor(EMAIL)
      storage.setItem(key, raw)
      assert.equal(positionToSeek(EMAIL, TRACK, FRESH), null)
    })

    // The read path above is inert whatever readMap hands back, so it does NOT
    // pin readMap's `typeof === 'object'` guard — verified by mutation: dropping
    // the guard leaves every read case green. The SAVE path is what pins it.
    // Without the guard readMap returns the parsed primitive itself, and
    // `map[key] = …` on a string, number or boolean throws a TypeError in strict
    // mode (ESM always is), which would take playback down rather than degrade.
    it(`recovers from ${label} on the next save`, () => {
      const key = storageKeyFor(EMAIL)
      storage.setItem(key, raw)
      assert.doesNotThrow(() => savePosition(EMAIL, TRACK, OK_TIME, DURATION))
      assert.equal(positionToSeek(EMAIL, TRACK, FRESH), OK_TIME)
    })
  }
})

describe('storage that throws (private mode, full quota)', () => {
  beforeEach(() => {
    installStorage('localStorage', createFailingStorage())
  })

  it('leaves every function inert rather than breaking playback', () => {
    assert.doesNotThrow(() => savePosition(EMAIL, TRACK, OK_TIME, DURATION))
    assert.doesNotThrow(() => clearPosition(EMAIL, TRACK))
    assert.equal(positionToSeek(EMAIL, TRACK, FRESH), null)
  })
})

describe('no localStorage at all', () => {
  beforeEach(() => {
    removeStorage('localStorage')
  })

  // What an SSR render or any non-browser import sees. The bare `catch` swallows
  // the ReferenceError, so "absent" degrades exactly like "throws" — asserted
  // separately because only one of the two is reachable in a browser.
  it('stays inert when the global is absent', () => {
    assert.doesNotThrow(() => savePosition(EMAIL, TRACK, OK_TIME, DURATION))
    assert.doesNotThrow(() => clearPosition(EMAIL, TRACK))
    assert.equal(positionToSeek(EMAIL, TRACK, FRESH), null)
  })
})
