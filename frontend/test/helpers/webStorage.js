// In-memory `Storage` stand-ins for the frontend unit suite (0XC-463).
//
// `lib/resume.js` reaches for the `localStorage` *global* rather than taking a
// storage object as an argument, so a unit test has to put one there. Node 22
// ships no `localStorage` at all without `--experimental-webstorage` — the
// property is absent from `globalThis`, not merely undefined — so installing one
// is a plain define, and `removeLocalStorage()` deletes it again rather than
// assigning `undefined`, which keeps the genuinely-absent state reachable. That
// state is worth testing on its own: it is what an SSR render or any non-browser
// import sees, and `resume.js`'s bare `catch` is what makes it inert.
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
// the two states `resume.js`'s try/catch exists for. `length` and `key` throw
// too, so a future reader that reaches for either is covered by the same case
// rather than passing because the double happened to be lenient there.
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

export function installLocalStorage(storage) {
  Object.defineProperty(globalThis, 'localStorage', {
    value: storage,
    configurable: true,
    writable: true,
  })
  return storage
}

export function removeLocalStorage() {
  delete globalThis.localStorage
}
