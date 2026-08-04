const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createStore, createMemoryStore } = require('./authStore');
const { runAuthStoreContract, USERS } = require('./authStore.contract');

// The memory implementation's run of the shared contract (0XC-330). It is the
// impl every route/middleware test in this repo injects, so it is always
// exercised — no database, no skip. `authStore.pg.test.js` runs the identical
// suite against the Postgres impl when TEST_DATABASE_URL points at one.
runAuthStoreContract({
  label: 'memory',
  // `createMemoryStore` takes its users at construction, so a fresh store is
  // just a fresh call — there is no shared table to clear between cases.
  freshStore: async () => createMemoryStore({ users: USERS.map((user) => ({ ...user })) }),
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

  // `_tokens` is the memory impl's declared test-only escape hatch, so the
  // underscore prefix is what marks something as deliberately not part of the
  // interface. Everything else has to match.
  //
  // Compares every public key, NOT just the function-valued ones: a guard that
  // filtered on `typeof === 'function'` would wave through a non-function
  // property added to one impl alone (the shape `_tokens` already has, minus the
  // underscore that exempts it), which is exactly the drift this test exists to
  // catch. Method-ness is then asserted separately, so "same keys, but one impl
  // exposes a value where the other exposes a method" still fails.
  const surfaceOf = (store) =>
    Object.keys(store)
      .filter((key) => !key.startsWith('_'))
      .sort();

  assert.deepEqual(surfaceOf(memory), surfaceOf(pg));
  assert.ok(surfaceOf(pg).length > 0, 'the interface is not empty');

  for (const key of surfaceOf(pg)) {
    assert.equal(typeof pg[key], 'function', `pg store's ${key} should be a method`);
    assert.equal(typeof memory[key], 'function', `memory store's ${key} should be a method`);
  }
});
