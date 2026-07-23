// Parses the table/column set a schema.sql file defines, so dbInit's
// drift assertion can be derived from schema.sql itself instead of a
// hand-maintained list that silently falls behind (0XC-129). Only presence
// is parsed — not types, defaults, or constraints.

const CREATE_TABLE_RE = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?("?)(\w+)"?\s*\(/gi;
// Postgres allows several `ADD COLUMN` clauses in one ALTER TABLE statement
// (`ALTER TABLE t ADD COLUMN a text, ADD COLUMN b text;`), so this is matched
// in two passes: ALTER_TABLE_RE finds the statement and its table name, then
// ADD_COLUMN_CLAUSE_RE is run over the statement's own body to find every
// clause inside it (see parseSchemaColumns).
const ALTER_TABLE_RE = /ALTER\s+TABLE\s+(?:ONLY\s+)?("?)(\w+)"?\s+([^;]*);/gi;
const ADD_COLUMN_CLAUSE_RE = /ADD\s+COLUMN\s+(?:IF\s+NOT\s+EXISTS\s+)?("?)(\w+)"?/gi;

// Table-level constraint lines start with one of these instead of a column
// name — e.g. `PRIMARY KEY (a, b)`, `UNIQUE (x)`, `FOREIGN KEY (...) REFERENCES …`.
// Matching on the leading word alone isn't enough: a column literally named
// `unique` or `check` would collide, so `isTableConstraintEntry` below also
// checks what follows before treating the entry as a constraint rather than
// a column. `LIKE other_table` is deliberately not in this set: unlike every
// other case here, "is the next token a table name?" can't be distinguished
// from "is the next token a type name?" without knowing real Postgres types,
// and schema.sql has never used a table-level LIKE clause. If one is ever
// added, its "like" is instead parsed as a phantom required column, which
// fails the boot-time assertion loudly (the same "fail loudly" principle
// parseSchemaColumns already applies below) rather than silently dropping a
// same-named real column the way an unconditional match would.
const TABLE_CONSTRAINT_KEYWORDS = new Set([
  'primary',
  'unique',
  'check',
  'foreign',
  'constraint',
  'exclude',
]);

// `word` is already confirmed to be one of TABLE_CONSTRAINT_KEYWORDS; `rest`
// is whatever follows it on the entry. Returns whether this really reads as
// the table-level constraint clause (vs. a column that happens to be named
// after the keyword, e.g. `unique boolean`).
function isTableConstraintEntry(word, rest) {
  const trimmedRest = rest.trim();
  switch (word) {
    case 'primary':
    case 'foreign':
      return /^key\b/i.test(trimmedRest);
    case 'unique':
      // PG15+ allows `UNIQUE NULLS NOT DISTINCT (cols)` before the column list.
      return trimmedRest.replace(/^nulls\s+not\s+distinct\s*/i, '').startsWith('(');
    case 'check':
      return trimmedRest.startsWith('(');
    case 'exclude':
      return trimmedRest.startsWith('(') || /^using\b/i.test(trimmedRest);
    case 'constraint':
      // `CONSTRAINT <name> PRIMARY KEY|UNIQUE|CHECK|FOREIGN KEY|EXCLUDE …` —
      // look for the real constraint keyword after the constraint's name.
      return /\b(primary|unique|check|foreign|exclude)\b/i.test(trimmedRest);
    default:
      return false;
  }
}

function stripComments(sql) {
  // Block comments first, so a `--` inside one doesn't confuse the line-comment
  // pass, and so commented-out example/legacy DDL is never parsed as real.
  return sql.replace(/\/\*[\s\S]*?\*\//g, '').replace(/--.*$/gm, '');
}

// Postgres folds an unquoted identifier to lowercase but preserves a quoted
// one exactly, so `CREATE TABLE Users` and a later `ALTER TABLE users` name
// the same real table, while `"Users"` would not. Matching this in the
// parser is what lets identifiers merge/key the same way the database sees
// them (`information_schema.columns` only ever holds the folded name).
function resolveIdentifier(quoted, name) {
  return quoted ? name : name.toLowerCase();
}

// Advances a shared paren-depth/string-literal/quoted-identifier scan state
// by one character. readBalancedParens, splitTopLevel, and the ALTER TABLE
// scan all need to track "are we inside a nested paren?", "inside a
// single-quoted string?" (`numeric(10,2)`, `'a,b(c)'`), and "inside a
// double-quoted identifier?" (`"a,b"`) so a comma or paren inside any of
// those is never mistaken for real structure — this is that one state
// machine, shared.
function advanceScanState(state, char) {
  if (state.inString) {
    if (char === "'") state.inString = false;
    return;
  }
  if (state.inQuotedIdent) {
    if (char === '"') state.inQuotedIdent = false;
    return;
  }
  if (char === "'") state.inString = true;
  else if (char === '"') state.inQuotedIdent = true;
  else if (char === '(') state.depth++;
  else if (char === ')') state.depth--;
}

function initialScanState(depth) {
  return { depth, inString: false, inQuotedIdent: false };
}

// Returns the substring between the '(' just consumed (at `openIndex`) and
// its matching close.
function readBalancedParens(sql, openIndex) {
  const state = initialScanState(1);
  for (let i = openIndex; i < sql.length; i++) {
    advanceScanState(state, sql[i]);
    if (state.depth === 0) return sql.slice(openIndex, i);
  }
  throw new Error('schema.sql parser: unbalanced parentheses in a CREATE TABLE body');
}

// Splits a CREATE TABLE body into its comma-separated column/constraint
// entries, respecting nested parens, string literals, and quoted identifiers
// so an internal comma never causes a false split.
function splitTopLevel(body) {
  const parts = [];
  const state = initialScanState(0);
  let start = 0;
  for (let i = 0; i < body.length; i++) {
    // A comma never changes the scan state itself, so checking state after
    // advancing is equivalent to checking before — and lets one call site
    // both update the state and test it.
    advanceScanState(state, body[i]);
    if (body[i] === ',' && state.depth === 0 && !state.inString && !state.inQuotedIdent) {
      parts.push(body.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(body.slice(start));
  return parts;
}

function columnNameFromEntry(entry) {
  const trimmed = entry.trim();
  if (!trimmed) return null;
  // A quoted identifier's content isn't restricted to \w — it can hold any
  // character except an unescaped `"` (e.g. `"a,b"`), so it's captured up to
  // its closing quote rather than by a word-character regex, and it's never
  // checked against TABLE_CONSTRAINT_KEYWORDS: quoting an identifier that
  // happens to spell a keyword makes it a literal name, never a constraint.
  if (trimmed[0] === '"') {
    const closeIndex = trimmed.indexOf('"', 1);
    return closeIndex === -1 ? null : trimmed.slice(1, closeIndex);
  }
  const match = trimmed.match(/^(\w+)/);
  if (!match) return null;
  const word = match[1].toLowerCase();
  if (TABLE_CONSTRAINT_KEYWORDS.has(word)) {
    const rest = trimmed.slice(match[0].length);
    if (isTableConstraintEntry(word, rest)) return null;
  }
  return word;
}

// Parses `sql` (a schema.sql file's contents) into `{ table: [column, …] }`.
// Throws if it finds zero columns across every table, or if it can't fully
// account for every `CREATE TABLE` statement in the file (e.g. a
// schema-qualified `CREATE TABLE public.foo (...)`, which this parser
// doesn't understand) — a parser that silently matches less than the whole
// file must fail loudly rather than pass on a partial result.
function parseSchemaColumns(sql) {
  const cleaned = stripComments(sql);
  const columnsByTable = {};
  const addColumn = (table, column) => {
    if (!columnsByTable[table]) columnsByTable[table] = new Set();
    columnsByTable[table].add(column);
  };

  let matchedCreateTables = 0;
  CREATE_TABLE_RE.lastIndex = 0;
  let match = CREATE_TABLE_RE.exec(cleaned);
  while (match) {
    matchedCreateTables++;
    const table = resolveIdentifier(match[1] === '"', match[2]);
    const openIndex = CREATE_TABLE_RE.lastIndex;
    const body = readBalancedParens(cleaned, openIndex);
    CREATE_TABLE_RE.lastIndex = openIndex + body.length + 1;
    for (const entry of splitTopLevel(body)) {
      const column = columnNameFromEntry(entry);
      if (column) addColumn(table, column);
    }
    match = CREATE_TABLE_RE.exec(cleaned);
  }

  const statementCount = (cleaned.match(/\bCREATE\s+TABLE\b/gi) || []).length;
  if (statementCount !== matchedCreateTables) {
    throw new Error(
      `schema.sql parser: found ${statementCount} CREATE TABLE statement(s) but only parsed ${matchedCreateTables} — check for schema-qualified names or other unsupported syntax`,
    );
  }

  ALTER_TABLE_RE.lastIndex = 0;
  match = ALTER_TABLE_RE.exec(cleaned);
  while (match) {
    const table = resolveIdentifier(match[1] === '"', match[2]);
    const statementBody = match[3];
    ADD_COLUMN_CLAUSE_RE.lastIndex = 0;
    let clause = ADD_COLUMN_CLAUSE_RE.exec(statementBody);
    while (clause) {
      addColumn(table, resolveIdentifier(clause[1] === '"', clause[2]));
      clause = ADD_COLUMN_CLAUSE_RE.exec(statementBody);
    }
    match = ALTER_TABLE_RE.exec(cleaned);
  }

  const result = {};
  for (const [table, columns] of Object.entries(columnsByTable)) {
    result[table] = [...columns];
  }
  // addColumn() only ever creates a table's entry at the same moment it adds
  // that table's first column, so an empty `result` here means the parser
  // matched nothing at all across the whole file — fail loudly rather than
  // pass vacuously.
  if (Object.keys(result).length === 0) {
    throw new Error('schema.sql parser found zero columns — refusing to silently pass');
  }
  return result;
}

module.exports = { parseSchemaColumns };
