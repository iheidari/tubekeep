// The Postgres run of the shared authStore contract (0XC-330).
//
// `createStore(query)` is what production runs, and until this file nothing
// executed a line of its SQL — so a divergence from the memory impl (which every
// route and middleware test injects) failed nothing. This runs the identical
// suite from `authStore.contract.js` against a real database, which is the only
// way to exercise the `lower(email)` lookup, the `expires_at > now()` comparison,
// and above all the atomicity of `consumeLoginToken`'s single
// `UPDATE … WHERE used_at IS NULL` — the property that keeps a magic link
// single-use under concurrent clicks, and which the single-threaded memory impl
// cannot fail.
//
// **It skips — never fails — without TEST_DATABASE_URL**, so `npm test` on a
// laptop stays hermetic and offline. CI supplies one from a `postgres:16`
// service container (see `.github/workflows/ci.yml`), the same variable
// `downloadsStore.pg.test.js` reads — no CI change was needed to add this file.
//
// It deliberately does NOT go through `db.js`: that module sets `ssl` on every
// pool unconditionally and would refuse a plain non-TLS test container. Rather
// than loosen a production TLS default for a test, this builds its own pool with
// `ssl: false` and hands `createStore` the injected query function it already
// takes. No production code changes.
//
// ## Why this run gets its own database
//
// `node --test` runs test FILES in parallel, and both pg contract runs need a
// `users` table they can clear between cases — so pointing both at the one
// `TEST_DATABASE_URL` database makes them stomp each other, in both directions:
// this file's `TRUNCATE … users` deletes the rows `downloadsStore.pg.test.js`
// just seeded (its inserts then fail `downloads_user_id_fkey`), and its truncate
// deletes these two identities out from under a lookup here (`findUserByEmail`
// starts returning null). Verified, not theorised: run the two files alone
// together and 5–6 cases fail every time. It stays green in a full `npm test`
// only because 300+ other tests happen to keep their windows apart — the worst
// kind of pass, and exactly the shape of 0XC-275 (test files racing over a
// shared resource, fixed there by taking the choice away rather than by
// coordinating).
//
// So this file derives a SIBLING database (`<name>_authstore`) and creates it on
// demand, leaving `TEST_DATABASE_URL`'s own database solely owned by
// `downloadsStore.pg.test.js`. That keeps the fix one-sided — no change to the
// existing pg harness, no CI change, no shared-state protocol for a future third
// file to remember. A new pg contract run should do the same: derive its own
// database, don't negotiate for the shared one.

const { after } = require('node:test');
const { Pool } = require('pg');

const { applySchema } = require('../dbInit');
const { createStore } = require('./authStore');
const { runAuthStoreContract, USERS, CONCURRENT_CONSUMERS } = require('./authStore.contract');

const connectionString = process.env.TEST_DATABASE_URL;

// node:test takes `false` for "run it" and a string for "skip, and say why".
const SKIP_REASON =
  'TEST_DATABASE_URL is unset — skipping the Postgres authStore contract run. ' +
  'Point it at a THROWAWAY database (this creates a sibling `<name>_authstore` database and ' +
  'truncates its `login_tokens` and `users`) to exercise the SQL branch, e.g. ' +
  'TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5432/tubekeep_test. ' +
  'CI supplies one from a postgres:16 service container.';

const skip = connectionString ? false : SKIP_REASON;

// `<name>_authstore`, alongside whatever TEST_DATABASE_URL names. Derived rather
// than configured so there is no second environment variable for CI to set.
function deriveSiblingUrl(base) {
  const url = new URL(base);
  const name = decodeURIComponent(url.pathname.replace(/^\//, '')) || 'postgres';
  const sibling = `${name}_authstore`;
  url.pathname = `/${encodeURIComponent(sibling)}`;
  return { url: url.toString(), name: sibling };
}

let pool;
let ready;

// Room for the contract's concurrency case to actually race — a pool of 1 would
// serialise those consumptions into sequential statements. Sizing off the
// contract's own constant keeps the two from drifting apart.
const POOL_MAX = CONCURRENT_CONSUMERS + 3;

// Create the sibling database (once per process) and apply the schema to it.
// CREATE DATABASE cannot run inside a transaction, which is fine — a pool query
// is autocommit. 42P04 is "duplicate_database": expected on every run after the
// first, since the database is deliberately left in place between runs (it is
// truncated per case, so nothing leaks).
async function ensureDatabase() {
  if (!ready) {
    ready = (async () => {
      const { url, name } = deriveSiblingUrl(connectionString);

      // Ended as soon as the CREATE lands: it is a one-shot connection to the
      // database TEST_DATABASE_URL names, and that is the database
      // `downloadsStore.pg.test.js` is concurrently working in — holding a
      // connection open there for the rest of this run buys nothing.
      const adminPool = new Pool({ connectionString, ssl: false, max: 1 });
      try {
        await adminPool.query(`CREATE DATABASE "${name}"`);
      } catch (err) {
        if (err.code !== '42P04') throw err;
      } finally {
        await adminPool.end();
      }

      pool = new Pool({ connectionString: url, ssl: false, max: POOL_MAX });

      // Reusing dbInit's applier rather than re-reading schema.sql means this
      // run also inherits its column-drift assertion, so a schema.sql the test
      // database can't satisfy fails here by name. The sibling database has its
      // own `public` schema, which is where schema.sql's tables land and where
      // that assertion looks — so the check stays meaningful here.
      await applySchema(pool);
    })();
  }

  return ready;
}

// Force `CONCURRENT_CONSUMERS` real connections to exist before a case runs.
//
// This is load-bearing, not tuning. A `pg.Pool` opens connections lazily, so
// firing N concurrent queries at a cold pool does NOT produce N concurrent
// statements: the first caller gets its connection while the rest are still
// doing TCP + auth, and finishes ALL of its statements before their first one
// lands. The contract's concurrency case then never races — verified by
// mutation on 0XC-330, where a deliberately non-atomic read-then-write
// `consumeLoginToken` passed it against a cold pool, and only failed once the
// connections were warmed.
//
// Cheap to repeat per case: after the first call these are already idle
// connections in the pool, so it is N round-trips of `SELECT 1`. Per-case rather
// than once, because pg reaps connections idle past `idleTimeoutMillis` (10s by
// default) and a slow suite would otherwise let the pool go cold again.
async function warmPool() {
  const clients = await Promise.all(
    Array.from({ length: CONCURRENT_CONSUMERS }, () => pool.connect()),
  );
  await Promise.all(clients.map((client) => client.query('SELECT 1')));
  for (const client of clients) client.release();
}

// A clean database plus the contract's two seeded identities. `login_tokens` has
// no FK to `users` (it carries a bare `email`), but both are truncated so a case
// never inherits a token or a row from the previous one. CASCADE is required
// because schema.sql also creates `downloads`, whose `user_id` references
// `users` — that table is unused here and stays empty.
async function freshStore() {
  await ensureDatabase();
  await warmPool();
  await pool.query('TRUNCATE login_tokens, users CASCADE');
  await pool.query(
    `INSERT INTO users (id, email, name, max_storage_bytes)
          SELECT * FROM unnest($1::uuid[], $2::text[], $3::text[], $4::bigint[])`,
    [
      USERS.map((user) => user.id),
      USERS.map((user) => user.email),
      USERS.map((user) => user.name),
      USERS.map((user) => user.max_storage_bytes),
    ],
  );
  return createStore(pool.query.bind(pool));
}

runAuthStoreContract({ label: 'postgres', freshStore, skip });

// Without this the process hangs on the open pool. No-op when the run skipped,
// since nothing ever created one. The admin pool needs no teardown here — it is
// ended the moment the CREATE lands (see `ensureDatabase`).
after(async () => {
  if (pool) await pool.end();
});
