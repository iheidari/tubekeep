// The Postgres run of the shared downloadsStore contract (0XC-110).
//
// `createStore(query)` is what production runs, and until this file nothing
// executed a line of its SQL — so a divergence from the memory impl (which every
// other test injects) failed nothing. This runs the identical suite from
// `downloadsStore.contract.js` against a real database, which is the only way to
// exercise `expireMissing`'s `$1::uuid[]` cast, both `interval '1 ms'` clauses,
// the `coalesce(sum(filesize), 0)` usage predicate, `markMoved`'s jsonb
// round-trip, the bigint→Number conversion in `toApiRow`, and
// `supersedeForUser`'s `DELETE … RETURNING`.
//
// **It skips — never fails — without TEST_DATABASE_URL**, so `npm test` on a
// laptop stays hermetic and offline. CI supplies one from a `postgres:16`
// service container (see `.github/workflows/ci.yml`).
//
// It deliberately does NOT go through `db.js`: that module sets `ssl` on every
// pool unconditionally and would refuse a plain non-TLS test container. Rather
// than loosen a production TLS default for a test, this builds its own pool with
// `ssl: false` and hands `createStore` the injected query function it already
// takes. No production code changes.

const { after } = require('node:test');
const { Pool } = require('pg');

const { applySchema } = require('../dbInit');
const { createStore } = require('./downloadsStore');
const { runDownloadsStoreContract, USER, OTHER } = require('./downloadsStore.contract');

const connectionString = process.env.TEST_DATABASE_URL;

// node:test takes `false` for "run it" and a string for "skip, and say why".
const SKIP_REASON =
  'TEST_DATABASE_URL is unset — skipping the Postgres downloadsStore contract run. ' +
  'Point it at a THROWAWAY database (this truncates `downloads` and `users`) to exercise the SQL branch, ' +
  'e.g. TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5432/tubekeep_test. ' +
  'CI supplies one from a postgres:16 service container.';

const skip = connectionString ? false : SKIP_REASON;

let pool;
let schemaApplied;

function getPool() {
  if (!pool) pool = new Pool({ connectionString, ssl: false, max: 4 });
  return pool;
}

// Applied once per process, not per test. Reusing dbInit's applier rather than
// re-reading schema.sql means this run also inherits its column-drift assertion,
// so a schema.sql the test database can't satisfy fails here by name.
function ensureSchema() {
  if (!schemaApplied) schemaApplied = applySchema(getPool());
  return schemaApplied;
}

// A clean database plus the two users the contract's rows hang off — `user_id`
// is a NOT NULL FK, so they have to exist before any insert. CASCADE takes the
// downloads with them; the explicit `downloads` in the list keeps the intent
// readable rather than relying on the cascade alone.
async function freshStore() {
  await ensureSchema();
  const active = getPool();
  await active.query('TRUNCATE downloads, users CASCADE');
  await active.query('INSERT INTO users (id, email) VALUES ($1, $2), ($3, $4)', [
    USER,
    'contract-user@example.test',
    OTHER,
    'contract-other@example.test',
  ]);
  return createStore(active.query.bind(active));
}

async function backdate(_store, downloadId, { createdAt, completedAt } = {}) {
  await getPool().query(
    `UPDATE downloads
        SET created_at = coalesce($2, created_at),
            completed_at = coalesce($3, completed_at)
      WHERE download_id = $1`,
    [downloadId, createdAt ?? null, completedAt ?? null],
  );
}

runDownloadsStoreContract({ label: 'postgres', freshStore, backdate, skip });

// Without this the process hangs on the open pool. No-op when the run skipped,
// since nothing ever created one.
after(async () => {
  if (pool) await pool.end();
});
