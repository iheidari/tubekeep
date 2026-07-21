const { test } = require('node:test');
const assert = require('node:assert/strict');

const { applySchema } = require('./dbInit');

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

test('applySchema resolves when every required column is present', async () => {
  const pool = fakePool({ downloads: ['download_id', 'user_id', 'completed_at', 'moved_info'] });
  await assert.doesNotReject(() => applySchema(pool));
  // The schema DDL ran before the column assertion.
  assert.ok(pool.queries.some((q) => q.includes('CREATE TABLE IF NOT EXISTS users')));
});

test('applySchema throws a clear error when a required column is missing', async () => {
  const pool = fakePool({ downloads: ['download_id'] });
  await assert.rejects(() => applySchema(pool), /downloads.*completed_at/s);
});

test('applySchema throws when the required table has no columns at all (e.g. missing table)', async () => {
  const pool = fakePool({});
  await assert.rejects(() => applySchema(pool), /downloads/);
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
