// The Postgres run of the shared authStore contract (0XC-330) — the only thing
// that executes `createStore(query)`'s SQL, and so the only thing that can catch
// it diverging from the memory impl every other test injects.
//
// It is the sibling of `downloadsStore.pg.test.js` and shares its two ground
// rules verbatim: it **skips, never fails, without TEST_DATABASE_URL** (so
// `npm test` stays hermetic offline), and it deliberately bypasses `db.js`,
// whose unconditional `ssl` would refuse a non-TLS test container — building its
// own `ssl: false` pool instead of loosening a production TLS default. See
// CLAUDE.md's contract-test section for the reasoning behind both.
//
// Two things are specific to this file, both load-bearing and both easy to undo
// by accident:
//
//   1. **It uses its own database** (`<name>_authstore`), because `node --test`
//      runs test files in parallel and both pg runs clear `users` — sharing one
//      database makes them truncate each other's rows in both directions (5-6
//      cases fail every time when the two files run alone together; a full
//      `npm test` hides it only because other tests keep their windows apart).
//      Same lesson as 0XC-275: take the choice away rather than coordinate. A
//      third pg contract run should derive its own database too.
//   2. **It pre-warms the pool** before each case — see `warmPool`, which is
//      what keeps the contract's concurrency case from being vacuous.

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
//
// Query params are dropped, not carried over: an `sslmode=` in the base URL
// takes precedence over the explicit `ssl: false` below (verified against pg
// 8.22), which would silently reintroduce the TLS requirement this file exists
// to avoid — and `ssl: false` is the whole reason it doesn't go through db.js.
function deriveSiblingUrl(base) {
  const url = new URL(base);
  const name = decodeURIComponent(url.pathname.replace(/^\//, '')) || 'postgres';
  const sibling = `${name}_authstore`;
  url.pathname = `/${encodeURIComponent(sibling)}`;
  url.search = '';
  return { url: url.toString(), name: sibling };
}

// Postgres truncates identifiers at 63 bytes, so two long base names could
// otherwise collide on one sibling; doubling any `"` keeps a quoted identifier
// from breaking out. Both are defensive — a normal name hits neither.
function quoteIdentifier(name) {
  if (Buffer.byteLength(name) > 63) {
    throw new Error(
      `TEST_DATABASE_URL's database name is too long: "${name}" exceeds Postgres's 63-byte ` +
        'identifier limit once "_authstore" is appended, so it would be silently truncated and ' +
        'could collide with another database. Use a shorter name.',
    );
  }
  return `"${name.replace(/"/g, '""')}"`;
}

// The marker table that says "this sibling database belongs to this test file".
// See `adoptOrRefuse` for why it exists.
const OWNER_MARKER = 'authstore_contract_owner';

let pool;
let ready;

// Room for the contract's concurrency case to actually race — a pool of 1 would
// serialise those consumptions into sequential statements. Sizing off the
// contract's own constant keeps the two from drifting apart.
const POOL_MAX = CONCURRENT_CONSUMERS + 3;

// Create the sibling database if it isn't there. Returns whether THIS call
// created it, which is what `adoptOrRefuse` needs to know.
//
// CREATE DATABASE cannot run inside a transaction, which is fine — a pool query
// is autocommit. Two error codes are expected rather than exceptional:
//   42P04 duplicate_database — every run after the first; the database is left
//         in place between runs deliberately (it is truncated per case).
//   42501 insufficient_privilege — the role can't create databases. That is a
//         real requirement this file adds and `downloadsStore.pg.test.js` does
//         not have, so it must say so plainly instead of surfacing a bare
//         "permission denied to create database", and must name the way out.
async function createSiblingDatabase(name) {
  // Ended as soon as the CREATE lands: it is a one-shot connection to the
  // database TEST_DATABASE_URL names, and that is the database
  // `downloadsStore.pg.test.js` is concurrently working in — holding a
  // connection open there for the rest of this run buys nothing.
  const adminPool = new Pool({ connectionString, ssl: false, max: 1 });
  try {
    await adminPool.query(`CREATE DATABASE ${quoteIdentifier(name)}`);
    return true;
  } catch (err) {
    if (err.code === '42P04') return false;
    if (err.code === '42501') {
      throw new Error(
        `The Postgres authStore contract run needs its own database and could not create one: ` +
          `the role in TEST_DATABASE_URL lacks CREATEDB. Either grant it, or create an EMPTY ` +
          `database named "${name}" by hand (this run will adopt an empty one and manage it ` +
          `from then on), or unset TEST_DATABASE_URL to skip the Postgres runs entirely. ` +
          `It needs a separate database because it and downloadsStore.pg.test.js both clear ` +
          `\`users\`, and node:test runs test files in parallel.`,
      );
    }
    throw err;
  } finally {
    await adminPool.end();
  }
}

// Decide whether we may TRUNCATE this database, and refuse if we may not.
//
// Without this check, swallowing 42P04 means silently adopting — and clearing —
// a pre-existing `<name>_authstore` that the operator never pointed us at and
// may well care about. TEST_DATABASE_URL's "never a real database" warning only
// covers the database it NAMES; the sibling is one this file invented, so it has
// to earn the right to destroy it rather than assume it.
//
// A database is ours if we just created it, or if it carries our marker table,
// or if it is empty (which is what hand-provisioning for the no-CREATEDB path
// above leaves behind). Anything else — a database with tables but no marker —
// is someone else's, and we stop.
async function adoptOrRefuse(name, created) {
  if (!created) {
    const { rows } = await pool.query(
      `SELECT to_regclass($1) IS NOT NULL AS marked,
              EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'public') AS has_tables`,
      [`public.${OWNER_MARKER}`],
    );
    if (!rows[0].marked && rows[0].has_tables) {
      throw new Error(
        `Refusing to use the existing database "${name}": this run TRUNCATEs it, but it was ` +
          `not created by this test and carries no \`${OWNER_MARKER}\` marker table, so it is ` +
          `someone else's data. Drop it (or point TEST_DATABASE_URL at a differently-named ` +
          `database) and re-run.`,
      );
    }
  }

  // Reusing dbInit's applier rather than re-reading schema.sql means this run
  // also inherits its column-drift assertion, so a schema.sql the test database
  // can't satisfy fails here by name. The sibling database has its own `public`
  // schema, which is where schema.sql's tables land and where that assertion
  // looks — so the check stays meaningful here.
  await applySchema(pool);
  await pool.query(`CREATE TABLE IF NOT EXISTS ${OWNER_MARKER} (note text)`);
}

// Once per process.
async function ensureDatabase() {
  if (!ready) {
    ready = (async () => {
      const { url, name } = deriveSiblingUrl(connectionString);
      const created = await createSiblingDatabase(name);
      pool = new Pool({ connectionString: url, ssl: false, max: POOL_MAX });
      await adoptOrRefuse(name, created);
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
