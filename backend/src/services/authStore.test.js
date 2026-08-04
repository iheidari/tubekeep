const { test } = require('node:test');

const { createStore, createMemoryStore } = require('./authStore');
const { assertSameStoreSurface } = require('./storeSurface');
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
  // calls through to it. The assertion itself is shared with the repo's other
  // two-impl store — see storeSurface.js for what it checks and why.
  assertSameStoreSurface(
    createStore(async () => ({ rows: [], rowCount: 0 })),
    createMemoryStore(),
  );
});
