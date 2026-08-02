// Schema applier. `applySchema(pool)` is the one code path both entry points
// share: the standalone `npm run db:init` CLI below, and server.js's boot
// sequence (which awaits it before listening — see CLAUDE.md's "Apply
// schema.sql automatically on boot"). The schema is idempotent
// (CREATE/ALTER … IF NOT EXISTS), so re-running it is always safe.
require('dotenv').config();

const fs = require('node:fs');
const path = require('node:path');
const { getPool } = require('./db');
const { parseSchemaColumns } = require('./schemaColumns');

const schemaPath = path.join(__dirname, '..', 'schema.sql');

// schema.sql's IF-NOT-EXISTS guards can't express every kind of drift (a
// column renamed or retyped by hand, a table dropped), so assert that every
// column schema.sql defines is actually present — this is what turns that
// class of drift into a boot-time failure instead of a silently swallowed
// hook error months later (0XC-115). The required set is parsed from
// schema.sql itself (`schemaColumns.js`) rather than hand-maintained, so a
// newly added column is covered automatically (0XC-129).
async function assertRequiredColumns(pool, sql) {
  const requiredColumns = parseSchemaColumns(sql);
  for (const [table, columns] of Object.entries(requiredColumns)) {
    const { rows } = await pool.query(
      // Qualify by schema too — schema.sql never sets search_path, so every
      // table it creates lands in "public", and an unqualified table_name
      // match would otherwise also count same-named tables in other schemas.
      'SELECT column_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2',
      ['public', table],
    );
    const present = new Set(rows.map((row) => row.column_name));
    const missing = columns.filter((column) => !present.has(column));
    if (missing.length > 0) {
      throw new Error(`schema drift: table "${table}" is missing column(s): ${missing.join(', ')}`);
    }
  }
}

// Applies schema.sql, then asserts every column it defines landed. Takes a
// pool (or anything with a compatible `.query(text, params)`, e.g. a test
// double) rather than reaching for `getPool()` itself, so it stays
// unit-testable without a real database.
async function applySchema(pool) {
  const sql = fs.readFileSync(schemaPath, 'utf8');
  await pool.query(sql);
  await assertRequiredColumns(pool, sql);
}

async function main() {
  const pool = getPool();
  console.log('🗄️  Applying schema.sql to the database…');
  await applySchema(pool);
  console.log('✅ Schema applied.');
  await pool.end();
}

// Only run as the standalone `npm run db:init` CLI — requiring this module
// (from server.js) must not trigger a connection attempt of its own.
if (require.main === module) {
  main().catch((err) => {
    console.error('❌ db:init failed:', err.message);
    process.exit(1);
  });
}

module.exports = { applySchema };
