const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { parseSchemaColumns } = require('./schemaColumns');

test('parses the real schema.sql into its full per-table column sets', () => {
  const sql = fs.readFileSync(path.join(__dirname, '..', 'schema.sql'), 'utf8');
  const columns = parseSchemaColumns(sql);

  assert.ok(columns.downloads.includes('completed_at'));
  assert.ok(columns.users.includes('max_storage_bytes'));
  assert.deepEqual(
    new Set(columns.login_tokens),
    new Set(['token_hash', 'email', 'expires_at', 'used_at', 'created_at']),
  );
});

test('parses both `CREATE TABLE` and `CREATE TABLE IF NOT EXISTS`', () => {
  const sql = `
    CREATE TABLE plain (id uuid);
    CREATE TABLE IF NOT EXISTS guarded (id uuid);
  `;
  const columns = parseSchemaColumns(sql);
  assert.deepEqual(columns.plain, ['id']);
  assert.deepEqual(columns.guarded, ['id']);
});

test('does not split on commas or parens inside inline defaults/types', () => {
  const sql = `
    CREATE TABLE items (
      id uuid PRIMARY KEY,
      price numeric(10,2) NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      label text DEFAULT 'a,b(c)'
    );
  `;
  const columns = parseSchemaColumns(sql);
  assert.deepEqual(new Set(columns.items), new Set(['id', 'price', 'created_at', 'label']));
});

test('does not treat table-level constraint lines as columns', () => {
  const sql = `
    CREATE TABLE saved (
      user_id uuid NOT NULL,
      camp_id uuid NOT NULL,
      PRIMARY KEY (user_id, camp_id),
      UNIQUE (user_id, camp_id),
      CONSTRAINT saved_camp_fk FOREIGN KEY (camp_id) REFERENCES campgrounds (id),
      CHECK (user_id <> camp_id)
    );
  `;
  const columns = parseSchemaColumns(sql);
  assert.deepEqual(new Set(columns.saved), new Set(['user_id', 'camp_id']));
});

test('picks up ALTER TABLE ADD COLUMN IF NOT EXISTS', () => {
  const sql = `
    CREATE TABLE downloads (download_id uuid PRIMARY KEY);
    ALTER TABLE downloads ADD COLUMN IF NOT EXISTS moved_info jsonb;
    ALTER TABLE downloads ADD COLUMN completed_at timestamptz;
  `;
  const columns = parseSchemaColumns(sql);
  assert.deepEqual(
    new Set(columns.downloads),
    new Set(['download_id', 'moved_info', 'completed_at']),
  );
});

test('handles quoted identifiers', () => {
  const sql = `CREATE TABLE "orders" ("id" uuid PRIMARY KEY, "user" text);`;
  const columns = parseSchemaColumns(sql);
  assert.deepEqual(new Set(columns.orders), new Set(['id', 'user']));
});

test('ignores line comments', () => {
  const sql = `
    -- a comment mentioning fake_column that must not be parsed
    CREATE TABLE notes ( -- trailing comment
      id uuid PRIMARY KEY, -- the id
      body text
    );
  `;
  const columns = parseSchemaColumns(sql);
  assert.deepEqual(new Set(columns.notes), new Set(['id', 'body']));
});

test('throws instead of silently passing when it finds zero columns', () => {
  assert.throws(() => parseSchemaColumns('-- nothing but a comment\n'), /zero columns/);
});

test('merges columns from multiple CREATE TABLE statements naming the same table', () => {
  const sql = `
    CREATE TABLE dup (a uuid);
    CREATE TABLE dup (b uuid);
  `;
  const columns = parseSchemaColumns(sql);
  assert.deepEqual(new Set(columns.dup), new Set(['a', 'b']));
});

test('does not exclude a column whose name merely starts with a constraint keyword', () => {
  const sql = `
    CREATE TABLE t (
      id uuid PRIMARY KEY,
      check_in timestamptz,
      uniquefield text,
      primary_email text,
      foreign_key_id uuid,
      constraint_name text,
      excluded boolean,
      likeness text
    );
  `;
  const columns = parseSchemaColumns(sql);
  assert.deepEqual(
    new Set(columns.t),
    new Set([
      'id',
      'check_in',
      'uniquefield',
      'primary_email',
      'foreign_key_id',
      'constraint_name',
      'excluded',
      'likeness',
    ]),
  );
});

test('a column literally named after a table-level constraint keyword is still counted', () => {
  // columnNameFromEntry used to compare a column's leading identifier
  // against TABLE_CONSTRAINT_KEYWORDS by bare exact match, so a column
  // literally named `check`/`unique`/etc. collided with the keyword and was
  // silently dropped instead of counted — exactly the kind of silent gap
  // this ticket exists to close. isTableConstraintEntry now also checks
  // what follows the keyword (`KEY`, `(`, …) so only a real constraint
  // clause is excluded, not a same-named column.
  const sql = `
    CREATE TABLE t (
      id uuid PRIMARY KEY,
      check boolean,
      unique boolean,
      "primary" text,
      "foreign" boolean,
      exclude boolean,
      like boolean,
      PRIMARY KEY (id)
    );
  `;
  const columns = parseSchemaColumns(sql);
  assert.deepEqual(
    new Set(columns.t),
    new Set(['id', 'check', 'unique', 'primary', 'foreign', 'exclude', 'like']),
  );
});

test('a genuine FOREIGN KEY table constraint is still excluded even when a column is named `foreign`', () => {
  const sql = `
    CREATE TABLE t (
      id uuid PRIMARY KEY,
      "foreign" uuid NOT NULL,
      FOREIGN KEY ("foreign") REFERENCES other (id)
    );
  `;
  const columns = parseSchemaColumns(sql);
  assert.deepEqual(new Set(columns.t), new Set(['id', 'foreign']));
});

test('a CREATE TABLE with zero columns contributes no entry for that table', () => {
  // splitTopLevel('') / columnNameFromEntry('') both bottom out to null for
  // an empty body, so addColumn(table, …) is never called for a table with
  // no columns — the table doesn't even appear as an empty array in the
  // result. Pinned here because it means such a table is silently excluded
  // from dbInit's assertion entirely, rather than asserted-and-passing.
  const sql = `
    CREATE TABLE empty ();
    CREATE TABLE other (id uuid);
  `;
  const columns = parseSchemaColumns(sql);
  assert.deepEqual(Object.hasOwn(columns, 'empty'), false);
  assert.deepEqual(columns.other, ['id']);
});

test('ALTER TABLE ADD COLUMN for a table with no preceding CREATE TABLE still registers the column', () => {
  const sql = `ALTER TABLE ghost ADD COLUMN foo text;`;
  const columns = parseSchemaColumns(sql);
  assert.deepEqual(columns.ghost, ['foo']);
});

test('recognizes CREATE TABLE regardless of keyword case', () => {
  const sql = `
    Create Table Foo (id uuid);
    create table bar (id uuid);
    CREATE table baz (id uuid);
  `;
  const columns = parseSchemaColumns(sql);
  // Table names are unquoted, so Postgres folds them to lowercase — "Foo"
  // is not a distinct table from "foo" — see the case-folding test below.
  assert.deepEqual(columns.foo, ['id']);
  assert.deepEqual(columns.bar, ['id']);
  assert.deepEqual(columns.baz, ['id']);
});

test('parses correctly across tab- and newline-heavy whitespace', () => {
  const sql = 'CREATE\tTABLE\n\tspacey\t(\n\t\tid\tuuid\tPRIMARY\tKEY,\n\t\tname\ttext\n\t);';
  const columns = parseSchemaColumns(sql);
  assert.deepEqual(new Set(columns.spacey), new Set(['id', 'name']));
});

test('folds unquoted identifiers to lowercase (matching Postgres) but preserves quoted identifier case', () => {
  // Postgres folds an unquoted identifier's case but not a quoted one, so
  // "MixedCase" and a later "mixedcase" are the same real table, while
  // "PreservedCol" (quoted) is a distinct, case-sensitive column name. A
  // parser that preserved case for unquoted identifiers would key the
  // required-columns set by a name information_schema.columns never has,
  // making a perfectly healthy database fail the boot-time assertion.
  const sql = `
    CREATE TABLE MixedCase (
      SomeColumn uuid,
      "PreservedCol" text
    );
  `;
  const columns = parseSchemaColumns(sql);
  assert.deepEqual(Object.keys(columns), ['mixedcase']);
  assert.deepEqual(new Set(columns.mixedcase), new Set(['somecolumn', 'PreservedCol']));
});

test('an unquoted CREATE TABLE and a later unquoted ALTER TABLE with different casing merge into one table', () => {
  const sql = `
    CREATE TABLE Users (id uuid);
    ALTER TABLE users ADD COLUMN name text;
  `;
  const columns = parseSchemaColumns(sql);
  assert.deepEqual(Object.keys(columns), ['users']);
  assert.deepEqual(new Set(columns.users), new Set(['id', 'name']));
});

test('a single ALTER TABLE statement with multiple ADD COLUMN clauses registers every column', () => {
  const sql = `
    CREATE TABLE t (id uuid);
    ALTER TABLE t ADD COLUMN a text, ADD COLUMN IF NOT EXISTS b text, ADD COLUMN "C" text;
  `;
  const columns = parseSchemaColumns(sql);
  assert.deepEqual(new Set(columns.t), new Set(['id', 'a', 'b', 'C']));
});

test('ALTER TABLE ONLY <table> still registers its added column', () => {
  const sql = `
    CREATE TABLE t (id uuid);
    ALTER TABLE ONLY t ADD COLUMN a text;
  `;
  const columns = parseSchemaColumns(sql);
  assert.deepEqual(new Set(columns.t), new Set(['id', 'a']));
});

test('strips /* block comments */, including ones that would otherwise parse as a real table', () => {
  const sql = `
    /* CREATE TABLE fake_table (should_not_appear uuid); */
    CREATE TABLE real_table ( -- inline note
      /* an inline block comment */ id uuid PRIMARY KEY,
      name text
    );
  `;
  const columns = parseSchemaColumns(sql);
  assert.deepEqual(Object.hasOwn(columns, 'fake_table'), false);
  assert.deepEqual(new Set(columns.real_table), new Set(['id', 'name']));
});

test('recognizes UNIQUE NULLS NOT DISTINCT (PG15+) as a table-level constraint, not a phantom column', () => {
  const sql = `
    CREATE TABLE t (
      id uuid,
      email text,
      UNIQUE NULLS NOT DISTINCT (email)
    );
  `;
  const columns = parseSchemaColumns(sql);
  assert.deepEqual(new Set(columns.t), new Set(['id', 'email']));
});

test('a schema-qualified CREATE TABLE this parser cannot understand fails loudly instead of silently dropping that table', () => {
  const sql = `
    CREATE TABLE users (id uuid);
    CREATE TABLE public.downloads (download_id uuid);
  `;
  assert.throws(
    () => parseSchemaColumns(sql),
    /found 2 CREATE TABLE statement\(s\) but only parsed 1/,
  );
});

test('a quoted identifier containing a comma does not cause a false top-level split', () => {
  const sql = `CREATE TABLE t ("a,b" uuid, c text);`;
  const columns = parseSchemaColumns(sql);
  assert.deepEqual(new Set(columns.t), new Set(['a,b', 'c']));
});
