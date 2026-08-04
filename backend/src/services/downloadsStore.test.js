const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createStore, createMemoryStore } = require('./downloadsStore');
const { runDownloadsStoreContract } = require('./downloadsStore.contract');

// The memory implementation's run of the shared contract (0XC-110). It is the
// impl every other test in this repo injects, so it is always exercised — no
// database, no skip. `downloadsStore.pg.test.js` runs the identical suite
// against the Postgres impl when TEST_DATABASE_URL points at one.
runDownloadsStoreContract({
  label: 'memory',
  freshStore: async () => createMemoryStore(),
  // The one thing no public method can express: created_at/completed_at are
  // stamped by the store itself, and both interval clauses key off them.
  backdate: async (store, downloadId, { createdAt, completedAt } = {}) => {
    const row = store._rows.get(downloadId);
    if (!row) throw new Error(`backdate: no such row ${downloadId}`);
    if (createdAt) row.created_at = createdAt;
    if (completedAt) row.completed_at = completedAt;
  },
});

// The contract suite proves each impl behaves; this proves they still describe
// the SAME interface. A method added to only one of them would otherwise sail
// through — the contract can only assert on methods it already knows to call,
// so the new one would be untested on the impl that has it and missing on the
// other until a route hit `undefined is not a function` in production.
test('both implementations expose the same method set', () => {
  // createStore only needs *a* query function to be constructed; nothing here
  // calls through to it.
  const pg = createStore(async () => ({ rows: [], rowCount: 0 }));
  const memory = createMemoryStore();

  // `_rows` is the memory impl's declared test-only escape hatch, so the
  // underscore prefix is what marks something as deliberately not part of the
  // interface. Everything else has to match.
  //
  // Compares every public key, NOT just the function-valued ones: filtering on
  // `typeof === 'function'` before comparing would wave through a non-function
  // property added to one impl alone (the shape `_rows` already has, minus the
  // exempting underscore), which is exactly the drift this test exists to catch.
  // Method-ness is asserted separately, so "same keys, but one impl exposes a
  // value where the other exposes a method" still fails. Kept identical to
  // `authStore.test.js`'s guard (0XC-330) so the two can't drift apart.
  const surfaceOf = (store) =>
    Object.keys(store)
      .filter((key) => !key.startsWith('_'))
      .sort();

  const surface = surfaceOf(pg);
  assert.deepEqual(surfaceOf(memory), surface);
  assert.ok(surface.length > 0, 'the interface is not empty');

  for (const key of surface) {
    assert.equal(typeof pg[key], 'function', `pg store's ${key} should be a method`);
    assert.equal(typeof memory[key], 'function', `memory store's ${key} should be a method`);
  }
});
