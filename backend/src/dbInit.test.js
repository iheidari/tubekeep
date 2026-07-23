const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { applySchema } = require('./dbInit');
const { parseSchemaColumns } = require('./schemaColumns');

// The real, parsed schema.sql column set — not a hand-picked subset — so
// these tests track whatever schema.sql actually defines instead of
// maintaining a second list that can drift from it (0XC-129).
const realSchemaSql = fs.readFileSync(path.join(__dirname, '..', 'schema.sql'), 'utf8');
const realColumns = parseSchemaColumns(realSchemaSql);

// A fake pool that never touches a real database: it records every query,
// answers information_schema lookups from a canned column list, and no-ops
// everything else (standing in for the schema.sql DDL). Lets us exercise the
// post-apply column assertion without Postgres in CI (0XC-115).
function fakePool(columnsByTable) {
  const queries = [];
  return {
    queries,
    async query(text, params) {
      queries.push(text);
      if (text.includes('information_schema.columns')) {
        const table = params[1];
        const columns = columnsByTable[table] || [];
        return { rows: columns.map((column_name) => ({ column_name })) };
      }
      return { rows: [] };
    },
  };
}

test('applySchema resolves when every column schema.sql defines is present', async () => {
  const pool = fakePool(realColumns);
  await assert.doesNotReject(() => applySchema(pool));
  // The schema DDL ran before the column assertion.
  assert.ok(pool.queries.some((q) => q.includes('CREATE TABLE IF NOT EXISTS users')));
});

test('applySchema throws a clear error when a downloads column is missing', async () => {
  const columnsByTable = {
    ...realColumns,
    downloads: realColumns.downloads.filter((column) => column !== 'completed_at'),
  };
  const pool = fakePool(columnsByTable);
  await assert.rejects(() => applySchema(pool), /downloads.*completed_at/s);
});

test('applySchema throws when a users column is missing (previously uncovered by the hand-maintained list)', async () => {
  const columnsByTable = {
    ...realColumns,
    users: realColumns.users.filter((column) => column !== 'max_storage_bytes'),
  };
  const pool = fakePool(columnsByTable);
  await assert.rejects(() => applySchema(pool), /users.*max_storage_bytes/s);
});

test('applySchema throws when a required table has no columns at all (e.g. missing table)', async () => {
  const columnsByTable = { ...realColumns, login_tokens: [] };
  const pool = fakePool(columnsByTable);
  await assert.rejects(() => applySchema(pool), /login_tokens/);
});

test('applySchema propagates a schema DDL failure and never reaches the column assertion', async () => {
  // A bad schema.sql (syntax error, permissions issue, etc.) must surface as-is
  // rather than being swallowed or masked by a later "missing column" message.
  const ddlError = new Error('syntax error at or near "TABEL"');
  let infoSchemaQueried = false;
  const pool = {
    async query(text) {
      if (text.includes('information_schema.columns')) {
        infoSchemaQueried = true;
        return { rows: [] };
      }
      throw ddlError;
    },
  };
  await assert.rejects(() => applySchema(pool), /syntax error/);
  assert.strictEqual(
    infoSchemaQueried,
    false,
    'the column assertion must not run after a DDL failure',
  );
});
