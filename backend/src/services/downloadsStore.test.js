const { test } = require('node:test');

const { createStore, createMemoryStore } = require('./downloadsStore');
const { assertSameStoreSurface } = require('./storeSurface');
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
  // calls through to it. The assertion itself is shared with the repo's other
  // two-impl store — see storeSurface.js for what it checks and why.
  assertSameStoreSurface(
    createStore(async () => ({ rows: [], rowCount: 0 })),
    createMemoryStore(),
  );
});
