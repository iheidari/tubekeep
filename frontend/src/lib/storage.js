// One audited home for guarded web-storage access (0XC-464).
//
// Every web-storage call can throw: `localStorage`/`sessionStorage` are absent
// or poisoned in some private modes, and `setItem` throws `QuotaExceededError`
// once the origin's quota is full — a quota shared with every other key on the
// domain, so one feature can be killed off by another's growth. None of that
// may be allowed to break the page, so every access here is swallowed.
//
// The swallowing is precisely why this is one module rather than four. A
// swallowed failure has no symptom by construction, and the four hand-rolled
// wrappers this replaced had already drifted — some parsed JSON, some did not,
// some validated the parsed shape. `lib/resume.js` is the sharpest case: it has
// no UI at all, so a full quota killed resume permanently with nothing to
// notice. With the catch in one place, adding a dev-mode `console.warn` behind
// it later is one edit instead of four.
//
// These helpers are deliberately *only* the guard plus the JSON hop. Shape
// validation stays at the call site, which is the only place that knows what it
// stored — see `resume.js`'s `typeof parsed === 'object'` guard, which is what
// makes corrupt stored JSON inert rather than throwing.

/**
 * The `localStorage` / `sessionStorage` object, or `null` when it cannot be
 * reached. Callers pass `localStore()`, never the bare global.
 *
 * Resolving the global *here* rather than at the call site is load-bearing.
 * `localStorage` is a bare identifier, so reading it throws `ReferenceError`
 * wherever the global does not exist — an SSR render, any non-browser import,
 * the unit suite — and some private modes throw on the property access itself.
 * The four hand-rolled wrappers this module replaced dereferenced the global
 * *inside* their own `try`, so both cases were swallowed. Passing the store in
 * as an argument evaluates it at the call site, outside the guards below, which
 * resurrects exactly the crash they exist to prevent (0XC-464). Going through
 * `globalThis` keeps the read a property access rather than an identifier
 * lookup, and the `try` covers the private modes that throw on it anyway.
 *
 * A `null` store needs no special case downstream: `null.getItem` is a
 * `TypeError` raised inside each helper's own `try`, so it degrades down the
 * same path as a store whose methods throw.
 */
export function localStore() {
  try {
    return globalThis.localStorage ?? null
  } catch {
    return null
  }
}

/** The `sessionStorage` object, or `null` — see `localStore`. */
export function sessionStore() {
  try {
    return globalThis.sessionStorage ?? null
  } catch {
    return null
  }
}

/**
 * Parsed JSON at `key`, or `fallback` when it is absent, unreadable or not
 * valid JSON. An empty stored string reads as absent, matching `getItem`'s own
 * "nothing useful here" — and matching every wrapper this replaced.
 *
 * The parsed value is returned as-is: a caller that stored an object gets
 * whatever is actually there, which may be a number or `null` after someone
 * else's write. Validate at the call site if that distinction matters.
 */
export function readJson(storage, key, fallback = null) {
  try {
    const raw = storage.getItem(key)
    return raw ? JSON.parse(raw) : fallback
  } catch {
    return fallback
  }
}

/** Store `value` as JSON. Unavailable or full storage is a silent no-op. */
export function writeJson(storage, key, value) {
  try {
    storage.setItem(key, JSON.stringify(value))
  } catch {
    // unavailable or full — the caller's feature degrades, the page does not
  }
}

/**
 * Store `value` verbatim, skipping the JSON hop.
 *
 * `lib/theme.js` is the one caller and genuinely needs it: the no-FOUC inline
 * script in `index.html` compares the stored value with `t === 'dark'`, so a
 * JSON-quoted `"dark"` would read as "no preference" and silently reset every
 * existing user to their system default on the next load. Reach for `writeJson`
 * unless something outside this app parses the raw value.
 */
export function writeText(storage, key, value) {
  try {
    storage.setItem(key, value)
  } catch {
    // unavailable or full — see writeJson
  }
}

/** Remove `key`. Unavailable storage is a silent no-op. */
export function removeKey(storage, key) {
  try {
    storage.removeItem(key)
  } catch {
    // unavailable — there was nothing to remove either way
  }
}
