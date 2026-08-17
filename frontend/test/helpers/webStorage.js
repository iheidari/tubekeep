// In-memory `Storage` stand-ins for the frontend unit suite (0XC-463).
//
// `lib/resume.js` and `lib/media.js`'s start-params helpers reach for the
// `localStorage` / `sessionStorage` *globals* rather than taking a storage
// object as an argument, so a unit test has to put one there. Node 22 ships
// neither without `--experimental-webstorage` — the properties are absent from
// `globalThis`, not merely undefined — so installing one is a plain define, and
// `removeStorage()` deletes it again rather than assigning `undefined`, which
// keeps the genuinely-absent state reachable. That state is worth testing on its
// own: it is what an SSR render or any non-browser import sees, and the bare
// `catch` in each module is what makes it inert.
//
// `installStorage` takes the global's name rather than shipping a
// localStorage/sessionStorage pair of near-identical wrappers — the two differ
// only in which global they write, and a duplicated wrapper here would be the
// same shape 0XC-464 exists to collapse one directory over.
//
// Lives under `test/helpers/` rather than beside the source for the same reason
// `backend/test/helpers/spawnServer.js` does: the tests sit next to the modules
// they cover, the scaffolding they share does not.

// A working store. `dump()` is the one thing here that isn't part of the real
// `Storage` interface — a case needs to assert on what was written without
// knowing the hashed key `resume.js` files it under, and reading it back through
// `key(0)`/`getItem` would make every assertion depend on entry ordering.
export function createStorage(initial = {}) {
  const entries = new Map(Object.entries(initial))
  return {
    getItem: (key) => (entries.has(key) ? entries.get(key) : null),
    setItem: (key, value) => {
      entries.set(key, String(value))
    },
    removeItem: (key) => {
      entries.delete(key)
    },
    clear: () => {
      entries.clear()
    },
    key: (index) => [...entries.keys()][index] ?? null,
    get length() {
      return entries.size
    },
    dump: () => Object.fromEntries(entries),
  }
}

// Every operation throws, reproducing Safari private mode and a full quota —
// the two states the modules' try/catch blocks exist for. `length` and `key`
// throw too, so a future reader that reaches for either is covered by the same
// case rather than passing because the double happened to be lenient there.
export function createFailingStorage(message = 'QuotaExceededError') {
  const fail = () => {
    throw new Error(message)
  }
  return {
    getItem: fail,
    setItem: fail,
    removeItem: fail,
    clear: fail,
    key: fail,
    get length() {
      return fail()
    },
  }
}

// `name` is 'localStorage' or 'sessionStorage'.
export function installStorage(name, storage) {
  Object.defineProperty(globalThis, name, {
    value: storage,
    configurable: true,
    writable: true,
  })
  return storage
}

export function removeStorage(name) {
  delete globalThis[name]
}
