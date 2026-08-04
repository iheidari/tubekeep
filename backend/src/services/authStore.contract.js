// The behavioural contract `authStore.js`'s two implementations both have to
// satisfy — written once and run twice (0XC-330), mirroring the shape 0XC-110
// established for `downloadsStore`.
//
// `createStore(query)` is what production runs and `createMemoryStore()` is what
// every route/middleware test injects, so a divergence between them is a
// production bug nothing else in this repo can see: before this file the SQL
// branch had no execution coverage at all. Hence one suite over a `freshStore`
// factory rather than two parallel suites that would drift the moment either
// impl changed.
//
// The security-relevant case is **token consumption**: `verifyMagicLink` leans
// on a single atomic `UPDATE … WHERE used_at IS NULL AND expires_at > now()` to
// keep a magic link single-use even under concurrent clicks. That atomicity is a
// property of the SQL, and the memory impl cannot fail the test that proves it —
// it is single-threaded, so it passes for a reason the database does not share.
// The case is written for both anyway: it is the Postgres run that gives it
// teeth, and the memory run keeps the two impls describing the same behaviour.
//
// Unlike the downloadsStore contract there is **no `backdate` escape hatch**, and
// deliberately so. `downloads.created_at`/`completed_at` are `now()`-stamped by
// the store, so no public method could move them; `login_tokens.expires_at` is a
// parameter of `insertLoginToken`, so expiry is reachable through the interface
// and every case here sets up through public methods alone.
//
// Ids are real UUIDs because `users.id` is a `uuid` column, and a Postgres
// harness must seed those rows before any lookup (see `authStore.pg.test.js`).
//
// ## Known divergences — deliberately NOT asserted here
//
// Three inputs make the two impls behave differently. None is a contract case,
// because no single assertion is true of both; they are recorded here so the
// next person meets them in a comment rather than in a failing run they assume
// they caused. Verified on 0XC-330, not inferred:
//
// - **`max_storage_bytes` representation** — node-postgres returns `bigint` as a
//   STRING (it cannot promise every int8 fits a float64); memory returns the
//   seeded number. Both consumers already coerce, so the projection case pins
//   the numeric value. See the comment there.
// - **A duplicate `tokenHash`** — pg raises `23505` (`token_hash` is the PK);
//   memory silently overwrites the row, so a second insert reassigns the token
//   to a different email. Unreachable in production: `authService` mints a fresh
//   32-byte random token per request, so a collision means the RNG failed.
// - **A malformed uuid into `findUserById`** — pg raises `22P02`; memory returns
//   `null`. Also unreachable in production: the id comes from a JWT `sub` this
//   server signed.
//
// If either of the last two ever becomes reachable, the fix is to converge the
// IMPLS and then add the case — not to add a case that accepts both answers.

const { test } = require('node:test');
const assert = require('node:assert/strict');

// The two seeded identities. ALICE's email is deliberately stored mixed-case:
// the schema stores plain `text` (no citext), and `findUserByEmail` lowercases
// BOTH sides precisely so a hand-entered row in the Neon dashboard still
// matches. Storing it lower-case here would make that lookup look correct while
// only ever exercising the trivial half.
const ALICE = {
  id: '33333333-3333-4333-8333-333333333333',
  email: 'Alice@Example.test',
  name: 'Alice',
  max_storage_bytes: 5368709120, // the schema default, and > 2^32 on purpose (see below)
};

// `name` null and the -1 "unlimited" sentinel, so the projection is exercised
// over a row that is not all-populated-and-positive.
const BOB = {
  id: '44444444-4444-4444-8444-444444444444',
  email: 'bob@example.test',
  name: null,
  max_storage_bytes: -1,
};

const USERS = [ALICE, BOB];

const MINUTE = 60 * 1000;

// How many consumptions the concurrency case fires at one token. Exported so a
// harness that has to prepare for real concurrency (the Postgres one pre-warms
// exactly this many pooled connections — see `authStore.pg.test.js`) can size
// itself from the same constant instead of guessing, and can't drift below it.
const CONCURRENT_CONSUMERS = 5;

// Hashes are opaque to the store (authService hands it a SHA-256 hex digest), so
// any stable distinct string will do — these are labelled for readable diffs.
const hash = (label) => `hash-${label}`;

// A token that is comfortably live. Every case that is not ABOUT expiry wants
// only "not expired", so the exact margin carries no meaning; the two cases that
// do test the boundary build their Date inline, where the value is the point.
const liveExpiry = () => new Date(Date.now() + 15 * MINUTE);

/**
 * Register the whole contract against one implementation.
 *
 * @param {object} harness
 * @param {string} harness.label      Prefixed to every test name, so a failure names the impl.
 * @param {() => Promise<object>} harness.freshStore  An empty store seeded with USERS and no tokens.
 * @param {false|string} [harness.skip]  A reason string skips every case (see the pg harness).
 */
function runAuthStoreContract({ label, freshStore, skip = false }) {
  const it = (name, fn) => test(`${label}: ${name}`, { skip }, fn);

  // --- user lookup ----------------------------------------------------------

  it('findUserByEmail matches case-insensitively on both sides', async () => {
    const store = await freshStore();

    // Stored mixed-case, queried four ways. All four must resolve, because the
    // login form is free text and the `users` row is typed by hand.
    for (const form of [
      'Alice@Example.test',
      'alice@example.test',
      'ALICE@EXAMPLE.TEST',
      'aLiCe@eXaMpLe.TeSt',
    ]) {
      const found = await store.findUserByEmail(form);
      assert.ok(found, `expected ${form} to resolve to the seeded user`);
      assert.equal(found.id, ALICE.id);
    }
  });

  it('findUserByEmail returns null for an address with no user row', async () => {
    const store = await freshStore();

    // This is the allowlist: no row means no login. `requestMagicLink` still
    // answers generically, so this null is the whole access-control decision.
    assert.equal(await store.findUserByEmail('nobody@example.test'), null);
    // A near-miss must not match either — the lookup is equality, not a prefix
    // or a LIKE.
    assert.equal(await store.findUserByEmail('alice@example.tes'), null);
    assert.equal(await store.findUserByEmail('alice@example.testt'), null);
  });

  it('findUserByEmail matches a SQL wildcard literally, never as a pattern', async () => {
    const store = await freshStore();

    // The case above says "equality, not a prefix or a LIKE" but cannot prove
    // the LIKE half: neither near-miss carries a wildcard, so both still fail a
    // pattern match and the assertion holds either way. Verified by mutation on
    // 0XC-330 — rewriting the lookup as `lower(email) LIKE $1` passed every
    // other case in this file.
    //
    // A pattern match here is an allowlist bypass: `%` selects an arbitrary
    // real user, and `findUserByEmail` is the whole of the "is this address
    // allowed to log in" decision AND the second half of `verifyMagicLink`
    // (which feeds it the consumed token's stored email). Nothing upstream
    // strips these characters — `requestMagicLink` only trims and lowercases.
    for (const pattern of [
      '%', // matches every row
      '%@example.test', // matches both seeded identities
      'alice@example%', // right-anchored prefix
      '_lice@example.test', // single-character wildcard
      'alice@example_test', // `_` standing in for the literal dot
    ]) {
      assert.equal(
        await store.findUserByEmail(pattern),
        null,
        `${pattern} must be compared as a literal string, not interpreted`,
      );
    }
  });

  it('findUserByEmail projects the session identity columns', async () => {
    const store = await freshStore();
    const found = await store.findUserByEmail(ALICE.email);

    assert.equal(found.id, ALICE.id);
    assert.equal(found.email, ALICE.email, 'the stored casing is returned verbatim');
    assert.equal(found.name, ALICE.name);

    // `max_storage_bytes` is `bigint`, and node-postgres returns int8 as a
    // STRING (it cannot promise every int8 fits a float64), while the memory
    // impl returns whatever number the test seeded. That divergence is real and
    // deliberately left in place: both consumers coerce (`routes/disk.js` and
    // `routes/download.js` each do `Number(req.user.max_storage_bytes)`), the
    // same defensive coercion `downloadsStore`'s `toApiRow` makes. So the
    // contract pins the NUMERIC value both impls agree on, and this comment is
    // the record of the representation they do not — asserting strict equality
    // here would fail the Postgres run for behaviour production handles.
    assert.equal(Number(found.max_storage_bytes), ALICE.max_storage_bytes);

    // No column beyond the four is exposed — `created_at` is not part of the
    // session identity and must not ride along into the JWT payload.
    assert.deepEqual(Object.keys(found).sort(), ['email', 'id', 'max_storage_bytes', 'name']);
  });

  it('findUserById round-trips, and misses on an unknown id', async () => {
    const store = await freshStore();

    // The auth middleware's per-request hydration path.
    const found = await store.findUserById(BOB.id);
    assert.equal(found.email, BOB.email);
    assert.equal(found.name, null, 'a null name survives the round trip');
    assert.equal(Number(found.max_storage_bytes), -1, 'the unlimited sentinel is preserved');

    // A valid-but-absent uuid: a session whose user row was deleted to revoke
    // access must stop resolving, which is how revocation actually takes effect.
    assert.equal(await store.findUserById('55555555-5555-4555-8555-555555555555'), null);
  });

  // --- token consumption ----------------------------------------------------

  it('a freshly inserted token consumes once, returning its email', async () => {
    const store = await freshStore();
    const expiresAt = liveExpiry();

    await store.insertLoginToken({ tokenHash: hash('a'), email: ALICE.email, expiresAt });

    assert.equal(await store.consumeLoginToken(hash('a')), ALICE.email);
  });

  it('a token is single-use — the second consume returns null', async () => {
    const store = await freshStore();
    const expiresAt = liveExpiry();
    await store.insertLoginToken({ tokenHash: hash('a'), email: ALICE.email, expiresAt });

    assert.equal(await store.consumeLoginToken(hash('a')), ALICE.email);
    // The `used_at IS NULL` half of the WHERE. A link forwarded, or simply
    // re-opened from the email, must not mint a second session.
    assert.equal(await store.consumeLoginToken(hash('a')), null);
    assert.equal(await store.consumeLoginToken(hash('a')), null);
  });

  it('concurrent consumption of one token yields exactly one winner', async () => {
    const store = await freshStore();
    const expiresAt = liveExpiry();
    await store.insertLoginToken({ tokenHash: hash('race'), email: ALICE.email, expiresAt });

    // THE case this contract exists for. Every consumption is issued before any
    // of them resolves, so against Postgres these genuinely race on separate
    // pooled connections: the first UPDATE takes the row lock, the rest block,
    // then re-evaluate `used_at IS NULL` against the committed row and match
    // zero rows. A read-then-write implementation hands out one session PER
    // caller here — verified by mutation, see the PR for 0XC-330.
    //
    // That verification is why `authStore.pg.test.js` pre-warms its pool. A pool
    // opens connections lazily, so without it the first caller completed both
    // its statements while the others were still authenticating, the race never
    // happened, and this case passed against a deliberately non-atomic impl —
    // green, and asserting nothing. If this ever moves off `freshStore`'s warmed
    // pool, re-run that mutation before trusting it again.
    //
    // The memory impl passes for a weaker reason (it is single-threaded and
    // never yields mid-consume), which is exactly why this case has to run
    // against the database to mean anything.
    const results = await Promise.all(
      Array.from({ length: CONCURRENT_CONSUMERS }, () => store.consumeLoginToken(hash('race'))),
    );

    const winners = results.filter((email) => email !== null);
    assert.deepEqual(winners, [ALICE.email], 'exactly one consumption may succeed');
  });

  it('an expired token is refused, and stays refused', async () => {
    const store = await freshStore();

    // The `expires_at > now()` half of the WHERE.
    await store.insertLoginToken({
      tokenHash: hash('stale'),
      email: ALICE.email,
      expiresAt: new Date(Date.now() - MINUTE),
    });

    assert.equal(await store.consumeLoginToken(hash('stale')), null);
    // Not a one-shot rejection that quietly marks it used and lets a retry
    // through — it is refused every time.
    assert.equal(await store.consumeLoginToken(hash('stale')), null);
  });

  it('expiry is exclusive — a token whose expires_at has just passed is refused', async () => {
    const store = await freshStore();

    // 1ms past the deadline — the tightest expression of "expired" both impls
    // can agree on without a clock stub. It catches the comparison being
    // dropped or inverted, but NOT `>` widened to `>=`: those differ only for a
    // token expiring at the same microsecond the query reads the clock, which
    // no test can arrange and no user can hit. That mutation was tried and
    // survives (an equivalent mutant, recorded on 0XC-330) — don't add a sleep
    // chasing it.
    await store.insertLoginToken({
      tokenHash: hash('boundary'),
      email: ALICE.email,
      expiresAt: new Date(Date.now() - 1),
    });

    assert.equal(await store.consumeLoginToken(hash('boundary')), null);
  });

  it('an unknown token hash consumes to null', async () => {
    const store = await freshStore();

    // A forged or truncated link. Must be indistinguishable from a used one.
    assert.equal(await store.consumeLoginToken(hash('never-issued')), null);
  });

  it('an unknown hash does not fall back to consuming some other live token', async () => {
    const store = await freshStore();
    const expiresAt = liveExpiry();
    await store.insertLoginToken({ tokenHash: hash('a'), email: ALICE.email, expiresAt });
    await store.insertLoginToken({ tokenHash: hash('b'), email: BOB.email, expiresAt });

    // The case above runs against an EMPTY store, so it proves only that a miss
    // returns null when there is nothing to hit — an impl that answered an
    // unknown hash with "whatever live token is lying around" passed it, and
    // passed every other case here too (verified by mutation on 0XC-330).
    // That impl hands a session to anyone who guesses a URL. So the miss has to
    // be asserted with live rows present, in a store holding both the oldest
    // and the newest token so neither `ORDER BY` direction can satisfy it.
    assert.equal(await store.consumeLoginToken(hash('never-issued')), null);

    // And the miss must not have burnt them on the way past.
    assert.equal(await store.consumeLoginToken(hash('a')), ALICE.email);
    assert.equal(await store.consumeLoginToken(hash('b')), BOB.email);
  });

  it('consumeLoginToken matches a SQL wildcard literally, never as a pattern', async () => {
    const store = await freshStore();
    const expiresAt = liveExpiry();
    await store.insertLoginToken({ tokenHash: hash('a'), email: ALICE.email, expiresAt });

    // The token-hash half of the same bug class the email lookup has above, and
    // it survived every other case here too. `token_hash LIKE $1` turns a
    // single `%` into "consume any live token and tell me whose it is" — a
    // login as an arbitrary user with no link and no email.
    //
    // Not reachable through the route today (authService hashes the raw token,
    // so only hex ever reaches this argument) — which is exactly why the store
    // has to hold the line itself rather than inherit it from a caller that
    // could change.
    for (const pattern of ['%', `${hash('a').slice(0, 6)}%`, hash('a').replace('-', '_')]) {
      assert.equal(
        await store.consumeLoginToken(pattern),
        null,
        `${pattern} must be compared as a literal string, not interpreted`,
      );
    }

    // Still live — no pattern attempt consumed it.
    assert.equal(await store.consumeLoginToken(hash('a')), ALICE.email);
  });

  it('consumption is independent of the users table', async () => {
    const store = await freshStore();
    const expiresAt = liveExpiry();

    // `login_tokens` carries a bare `email` with no FK to `users`, and
    // `verifyMagicLink` is a deliberate two-step: consume, THEN look the email
    // up. So the store must return the email of a token whose user row is gone
    // and let the caller's `findUserByEmail` be the one to refuse — adding a
    // join here would make the two impls disagree (the memory one has no users
    // to join against) while looking like a tightening. It also silently
    // changes behaviour: a rejected token would stay UNUSED, so re-adding the
    // user would bring an old link back to life.
    await store.insertLoginToken({
      tokenHash: hash('orphan'),
      email: 'nobody@example.test',
      expiresAt,
    });

    assert.equal(await store.consumeLoginToken(hash('orphan')), 'nobody@example.test');
    // The refusal happens here instead, one call later.
    assert.equal(await store.findUserByEmail('nobody@example.test'), null);
    // And it was still spent, so the link cannot be replayed.
    assert.equal(await store.consumeLoginToken(hash('orphan')), null);
  });

  it('consuming one token leaves every other token untouched', async () => {
    const store = await freshStore();
    const expiresAt = liveExpiry();
    await store.insertLoginToken({ tokenHash: hash('a'), email: ALICE.email, expiresAt });
    await store.insertLoginToken({ tokenHash: hash('b'), email: BOB.email, expiresAt });

    assert.equal(await store.consumeLoginToken(hash('a')), ALICE.email);
    // The UPDATE is keyed on the hash, so it must not sweep the table or match
    // by email — Bob's pending link is unrelated to Alice using hers.
    assert.equal(await store.consumeLoginToken(hash('b')), BOB.email);
  });

  it('a re-requested link does not invalidate the outstanding one', async () => {
    const store = await freshStore();
    const expiresAt = liveExpiry();

    // `requestMagicLink` inserts a row per request and never clears prior ones,
    // so a user who clicks "resend" then opens the FIRST email must still get
    // in. Both tokens are live and independent.
    await store.insertLoginToken({ tokenHash: hash('first'), email: ALICE.email, expiresAt });
    await store.insertLoginToken({ tokenHash: hash('second'), email: ALICE.email, expiresAt });

    assert.equal(await store.consumeLoginToken(hash('first')), ALICE.email);
    assert.equal(await store.consumeLoginToken(hash('second')), ALICE.email);
  });

  it('the email is returned exactly as it was stored', async () => {
    const store = await freshStore();
    const expiresAt = liveExpiry();

    // `verifyMagicLink` feeds this straight back into `findUserByEmail`, which
    // lowercases for itself — so the store must not normalise here. Round-trip
    // through both calls to prove the pair still composes.
    await store.insertLoginToken({ tokenHash: hash('cased'), email: ALICE.email, expiresAt });

    const email = await store.consumeLoginToken(hash('cased'));
    assert.equal(email, ALICE.email);
    assert.equal((await store.findUserByEmail(email)).id, ALICE.id);
  });
}

module.exports = { runAuthStoreContract, USERS, CONCURRENT_CONSUMERS };
