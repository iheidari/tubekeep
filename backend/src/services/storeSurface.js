// The shared drift guard for the repo's two-impl stores (0XC-330).
//
// `downloadsStore.js` and `authStore.js` each ship a Postgres `createStore(query)`
// and an in-memory `createMemoryStore()` behind one interface, and each has a
// contract suite proving the two BEHAVE the same. This proves they still
// DESCRIBE the same interface, which the contract cannot: a contract only calls
// methods it already knows about, so a method added to one impl alone would be
// untested on the impl that has it and simply absent from the other, until a
// route hit `undefined is not a function` in production.
//
// It lives here because both files' copies were byte-identical and kept in step
// by a comment asking the next person to keep them in step — which is the thing
// a shared assertion should own instead.

const assert = require('node:assert/strict');

// An underscore prefix is how both impls mark a test-only escape hatch
// (`downloadsStore`'s `_rows`, `authStore`'s `_tokens`) as deliberately outside
// the interface. Everything else has to match.
const surfaceOf = (store) =>
  Object.keys(store)
    .filter((key) => !key.startsWith('_'))
    .sort();

/**
 * Assert two implementations of one store interface expose the same surface.
 *
 * Compares every public key, NOT just the function-valued ones: filtering on
 * `typeof === 'function'` before comparing would wave through a non-function
 * property added to one impl alone (the shape `_rows`/`_tokens` already has,
 * minus the exempting underscore) — exactly the drift this exists to catch.
 * Method-ness is then asserted separately, so "same keys, but one impl exposes a
 * value where the other exposes a method" still fails.
 */
function assertSameStoreSurface(pg, memory) {
  const surface = surfaceOf(pg);

  assert.deepEqual(surfaceOf(memory), surface);
  assert.ok(surface.length > 0, 'the interface is not empty');

  for (const key of surface) {
    assert.equal(typeof pg[key], 'function', `pg store's ${key} should be a method`);
    assert.equal(typeof memory[key], 'function', `memory store's ${key} should be a method`);
  }
}

module.exports = { assertSameStoreSurface };
