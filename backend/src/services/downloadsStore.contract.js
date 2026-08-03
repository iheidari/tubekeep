// The behavioural contract `downloadsStore.js`'s two implementations both have
// to satisfy — written once and run twice (0XC-110).
//
// `createStore(query)` is what production runs and `createMemoryStore()` is what
// every other test injects, so a divergence between them is a production bug
// that nothing else in this repo can see: before this file the SQL branch had no
// execution coverage at all, and the memory impl was the only thing verified.
// Hence one suite over a `freshStore` factory rather than two parallel suites
// that would drift the moment either impl changed.
//
// Everything is set up through the store's OWN public methods — expire with
// `expireForUser`, fail with `markFailed`, move with `markMoved` — so the same
// lines drive a Map and a table. The single exception is `backdate`, injected by
// each harness: `created_at`/`completed_at` are `now()`-stamped by the store and
// no public method can move them, yet both interval clauses (`expireMissing`'s
// grace window, `failStale`'s stale window) are precisely what needs testing.
// Keep that the only escape hatch — anything else the harness has to reach
// around the interface for is a gap in the interface.
//
// Ids are real UUIDs because the `downloads.download_id` column is `uuid`, and
// `user_id` is an FK to `users`, so a Postgres harness must seed those two rows
// (see `downloadsStore.pg.test.js`). `nameOf` maps an id back to its readable
// label purely so an assertion diff says `['alsoOld', 'old']` rather than two
// UUIDs.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const USER = '11111111-1111-1111-1111-111111111111';
const OTHER = '22222222-2222-2222-2222-222222222222';

// Module-level so ids stay unique across both runs of the suite.
let seq = 0;
const nameById = new Map();

function id(name) {
  seq += 1;
  const value = `00000000-0000-4000-8000-${String(seq).padStart(12, '0')}`;
  nameById.set(value, name);
  return value;
}

const nameOf = (value) => nameById.get(value) || value;
const namesOf = (values) => values.map(nameOf).sort();

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

// A completed download of `size` bytes, seeded the way the app seeds one: insert
// (as `downloading`) then `markComplete` with the real filename and size.
async function seedComplete(store, downloadId, userId, size, opts = {}) {
  await store.insert({
    downloadId,
    userId,
    url: opts.url ?? `https://example.com/${downloadId}`,
    title: opts.title ?? 'a video',
    type: 'video',
    filesize: size,
    kept: opts.kept,
    sourceKey: opts.sourceKey,
  });
  await store.markComplete(downloadId, { filename: `${downloadId}.mp4`, filesize: size });
}

/**
 * Register the whole contract against one implementation.
 *
 * @param {object} harness
 * @param {string} harness.label      Prefixed to every test name, so a failure names the impl.
 * @param {() => Promise<object>} harness.freshStore  An empty store, with USER and OTHER able to own rows.
 * @param {(store, downloadId, times: {createdAt?: Date, completedAt?: Date}) => Promise<void>} harness.backdate
 * @param {false|string} [harness.skip]  A reason string skips every case (see the pg harness).
 */
function runDownloadsStoreContract({ label, freshStore, backdate, skip = false }) {
  const it = (name, fn) => test(`${label}: ${name}`, { skip }, fn);

  // --- listing & scoping ----------------------------------------------------

  it('listByUser returns only that user’s rows, newest first', async () => {
    const store = await freshStore();
    const [a, b, c] = [id('a'), id('b'), id('c')];
    await seedComplete(store, a, USER, 100);
    await seedComplete(store, b, OTHER, 100);
    await seedComplete(store, c, USER, 100);
    // Pin the order rather than trusting three `now()` stamps taken microseconds
    // apart to sort the way the test assumes.
    await backdate(store, a, { createdAt: new Date(Date.now() - 2 * HOUR) });
    await backdate(store, c, { createdAt: new Date(Date.now() - 1 * HOUR) });

    const mine = await store.listByUser(USER);
    assert.deepEqual(
      mine.map((row) => nameOf(row.downloadId)),
      ['c', 'a'],
    );
    assert.equal((await store.listByUser(OTHER)).length, 1);
  });

  it('findById resolves a download for anyone — the unscoped public-metadata read', async () => {
    const store = await freshStore();
    const a = id('a');
    await seedComplete(store, a, USER, 100);

    // findForUser is scoped and refuses; findById deliberately is not, because
    // the /api/files/meta route serves a shared link to a logged-out visitor.
    assert.equal(await store.findForUser(a, OTHER), null);
    assert.equal((await store.findById(a)).downloadId, a);
    assert.equal(await store.findById(id('never-inserted')), null);
  });

  it('another user’s id is "not found" for every mutating operation', async () => {
    const store = await freshStore();
    const a = id('a');
    await seedComplete(store, a, USER, 800);

    assert.equal(await store.findForUser(a, OTHER), null);
    assert.equal(await store.expireForUser(a, OTHER), false);
    assert.equal(await store.setKeptForUser(a, OTHER, true), false);
    assert.equal(await store.deleteForUser(a, OTHER), false);
    // ...and the row is untouched.
    const row = await store.findForUser(a, USER);
    assert.equal(row.expired, false);
    assert.equal(row.kept, false);
  });

  it('insert is idempotent — replaying a downloadId does not overwrite the row', async () => {
    const store = await freshStore();
    const a = id('a');
    await seedComplete(store, a, USER, 100);

    // The Postgres impl leans on ON CONFLICT DO NOTHING for this; a replayed
    // request must not reset a finished download back to `downloading`.
    await store.insert({ downloadId: a, userId: OTHER, url: 'https://other', filesize: 999 });

    const row = await store.findForUser(a, USER);
    assert.equal(row.status, 'complete');
    assert.equal(row.size, 100);
    assert.equal(await store.findForUser(a, OTHER), null);
  });

  // --- quota usage (USAGE_WHERE_SQL / countsTowardUsage) --------------------

  it('usage counts live rows, ignores expired / moved / failed and other users', async () => {
    const store = await freshStore();
    const [live, gone, cloud, broken, theirs] = [
      id('live'),
      id('gone'),
      id('cloud'),
      id('broken'),
      id('theirs'),
    ];
    await seedComplete(store, live, USER, 1000);
    await seedComplete(store, gone, USER, 500);
    await store.expireForUser(gone, USER);
    await seedComplete(store, cloud, USER, 700);
    await store.markMoved(cloud, { provider: 'dropbox' });
    await seedComplete(store, broken, USER, 300);
    await store.markFailed(broken);
    await seedComplete(store, theirs, OTHER, 9999);

    assert.equal(await store.usageForUser(USER), 1000);
  });

  it('an in-flight download counts toward usage so parallel starts cannot race past the cap', async () => {
    const store = await freshStore();
    await store.insert({ downloadId: id('pending'), userId: USER, filesize: 400, type: 'video' });
    assert.equal(await store.usageForUser(USER), 400);
  });

  it('usage is 0 for a user with no rows, and a sizeless row adds nothing', async () => {
    const store = await freshStore();
    assert.equal(await store.usageForUser(USER), 0);

    // A format whose size yt-dlp never reported. `coalesce(sum(filesize), 0)`
    // has to survive both the no-rows and the all-NULL case.
    const unknown = id('unknown');
    await store.insert({ downloadId: unknown, userId: USER, filesize: null });
    assert.equal(await store.usageForUser(USER), 0);
    assert.equal((await store.findForUser(unknown, USER)).size, null);
  });

  it('a multi-gigabyte size survives the bigint round-trip as a number', async () => {
    const store = await freshStore();
    const big = id('big');
    // Over 2^31, so pg hands `filesize` back as a *string* — the UI does
    // arithmetic on it, so toApiRow's Number() conversion is load-bearing.
    const size = 6 * 1024 * 1024 * 1024;
    await seedComplete(store, big, USER, size);

    const row = await store.findForUser(big, USER);
    assert.equal(typeof row.size, 'number');
    assert.equal(row.size, size);
    const used = await store.usageForUser(USER);
    assert.equal(typeof used, 'number');
    assert.equal(used, size);
  });

  // --- lifecycle: expire / delete / keep / move -----------------------------

  it('expiring frees the bytes; permanent delete removes the row entirely', async () => {
    const store = await freshStore();
    const a = id('a');
    await seedComplete(store, a, USER, 800);

    assert.equal(await store.expireForUser(a, USER), true);
    assert.equal(await store.usageForUser(USER), 0);
    const expired = await store.findForUser(a, USER);
    assert.equal(expired.expired, true);
    assert.ok(expired.expiredAt, 'expiring stamps expired_at');

    assert.equal(await store.deleteForUser(a, USER), true);
    assert.equal(await store.findForUser(a, USER), null);
  });

  it('an in-flight download cannot be expired — that would hide its bytes forever', async () => {
    const store = await freshStore();
    const running = id('running');
    await store.insert({ downloadId: running, userId: USER, filesize: 800 });

    // Expiring it here would exclude it from usage permanently: markComplete then
    // writes the real size onto an already-expired row, and expireMissing (which
    // only touches NOT expired rows) can never reconcile it back.
    assert.equal(await store.expireForUser(running, USER), false);

    await store.markComplete(running, { filename: 'r.mp4', filesize: 900 });
    assert.equal(await store.usageForUser(USER), 900);
    assert.equal(await store.expireForUser(running, USER), true);
    assert.equal(await store.usageForUser(USER), 0);
  });

  it('markComplete overwrites the client-supplied size estimate with the real one', async () => {
    const store = await freshStore();
    const a = id('a');
    await store.insert({ downloadId: a, userId: USER, filesize: 100 });
    await store.markComplete(a, { filename: 'a.mp4', filesize: 12345 });

    const row = await store.findForUser(a, USER);
    assert.equal(row.size, 12345);
    assert.equal(row.filename, 'a.mp4');
    assert.equal(await store.usageForUser(USER), 12345);
  });

  it('a moved row exposes its cloud link as `moved` so the UI renders a Moved card', async () => {
    const store = await freshStore();
    const a = id('a');
    await seedComplete(store, a, USER, 800);
    const info = { provider: 'dropbox', link: 'https://dropbox/x', path: '/Apps/Tubekeep/x.mp4' };
    await store.markMoved(a, info);

    // The whole object has to survive the jsonb round-trip, not just one key.
    assert.deepEqual((await store.findForUser(a, USER)).moved, info);
    assert.equal(await store.usageForUser(USER), 0);
  });

  it('a moved row with no provider info still reads as moved', async () => {
    const store = await freshStore();
    const a = id('a');
    await seedComplete(store, a, USER, 800);
    await store.markMoved(a, null);

    // `moved_info` is NULL but `moved` is true, and the UI keys the Moved card
    // off truthiness — so toApiRow has to hand back `{}`, never undefined.
    assert.deepEqual((await store.findForUser(a, USER)).moved, {});
    assert.equal(await store.usageForUser(USER), 0);
  });

  it('setKeptForUser flips the flag, and keptIds spans every user', async () => {
    const store = await freshStore();
    const [a, b, c] = [id('a'), id('b'), id('c')];
    await seedComplete(store, a, USER, 100, { kept: true });
    await seedComplete(store, b, USER, 100);
    await seedComplete(store, c, OTHER, 100, { kept: true });

    // keptIds is the cleanup sweep's exclusion set, so it is deliberately
    // unscoped — one user's pin must protect their files during a global sweep.
    assert.deepEqual(namesOf(await store.keptIds()), ['a', 'c']);

    assert.equal(await store.setKeptForUser(b, USER, true), true);
    assert.deepEqual(namesOf(await store.keptIds()), ['a', 'b', 'c']);
    assert.equal(await store.setKeptForUser(a, USER, false), true);
    assert.deepEqual(namesOf(await store.keptIds()), ['b', 'c']);
  });

  // --- the cleanup sweep's reconcile ----------------------------------------

  it('expireMissing retires rows whose media is gone, keeping those still on disk', async () => {
    const store = await freshStore();
    const [onDisk, vanished, running] = [id('onDisk'), id('vanished'), id('running')];
    await seedComplete(store, onDisk, USER, 100);
    await seedComplete(store, vanished, USER, 100);
    await store.insert({ downloadId: running, userId: USER, filesize: 100 });
    // Age them past the grace window (asserted separately below) so this case is
    // only about presence on disk, not about how recently they finished.
    const old = new Date(Date.now() - HOUR);
    for (const each of [onDisk, vanished, running]) {
      await backdate(store, each, { createdAt: old, completedAt: old });
    }

    assert.equal(await store.expireMissing([onDisk, running]), 1);
    assert.equal((await store.findForUser(vanished, USER)).expired, true);
    assert.equal((await store.findForUser(onDisk, USER)).expired, false);
    // An in-flight row has no media on disk yet — it must not be expired.
    assert.equal((await store.findForUser(running, USER)).expired, false);
  });

  it('expireMissing with an empty on-disk list expires every eligible row', async () => {
    const store = await freshStore();
    const [gone, cloud] = [id('gone'), id('cloud')];
    await seedComplete(store, gone, USER, 100);
    await seedComplete(store, cloud, USER, 100);
    await store.markMoved(cloud, { provider: 'dropbox' });
    const old = new Date(Date.now() - HOUR);
    for (const each of [gone, cloud]) {
      await backdate(store, each, { createdAt: old, completedAt: old });
    }

    // An empty directory snapshot is the ordinary "everything aged out" case,
    // and on the SQL side it is the one that puts an empty array through the
    // `$1::uuid[]` cast — a NOT (… = ANY('{}')) that must match every row.
    assert.equal(await store.expireMissing([]), 1);
    assert.equal((await store.findForUser(gone, USER)).expired, true);
    // A moved row's media is already gone on purpose; expiring it would drop
    // the cloud link the card is built from.
    assert.equal((await store.findForUser(cloud, USER)).expired, false);
  });

  it('expireMissing spares rows younger than the grace window', async () => {
    const store = await freshStore();
    const [justLanded, slowButFresh, longGone] = [
      id('justLanded'),
      id('slowButFresh'),
      id('longGone'),
    ];
    // A download that completed *during* the sweep is absent from the directory
    // snapshot the reconcile compares against — it must not be expired on arrival.
    await seedComplete(store, justLanded, USER, 100);
    // The window runs from COMPLETION, not creation: a download that took ten
    // hours and landed a moment ago is well past its grace period measured from
    // when it *started*, and would be expired the instant it finished. This is
    // the row that tells the two formulas apart — without it, swapping
    // `coalesce(completed_at, created_at)` for a bare `created_at` passes.
    await seedComplete(store, slowButFresh, USER, 100);
    await backdate(store, slowButFresh, { createdAt: new Date(Date.now() - 10 * HOUR) });
    // ...and the ordinary case: finished long ago, media gone, so it goes.
    await seedComplete(store, longGone, USER, 100);
    await backdate(store, longGone, {
      createdAt: new Date(Date.now() - 10 * HOUR),
      completedAt: new Date(Date.now() - HOUR),
    });

    assert.equal(await store.expireMissing([], 10 * MINUTE), 1);
    assert.equal((await store.findForUser(justLanded, USER)).expired, false);
    assert.equal((await store.findForUser(slowButFresh, USER)).expired, false);
    assert.equal((await store.findForUser(longGone, USER)).expired, true);
  });

  it('markComplete({ onlyIfDownloading: true }) reconciles a stranded row from the real file', async () => {
    const store = await freshStore();
    const stranded = id('stranded');
    await store.insert({ downloadId: stranded, userId: USER, filesize: 100 });

    assert.equal(
      await store.markComplete(
        stranded,
        { filename: 'real.mp4', filesize: 999 },
        { onlyIfDownloading: true },
      ),
      true,
    );

    const row = await store.findForUser(stranded, USER);
    assert.equal(row.status, 'complete');
    assert.equal(row.filename, 'real.mp4');
    assert.equal(row.size, 999);
    // The corrected size now counts toward the user's quota.
    assert.equal(await store.usageForUser(USER), 999);
  });

  it('markComplete({ onlyIfDownloading: true }) is a no-op for a row that is not (or no longer) downloading', async () => {
    const store = await freshStore();
    const alreadyDone = id('alreadyDone');
    await seedComplete(store, alreadyDone, USER, 100);
    await store.markFailed(alreadyDone); // pretend it raced with something else

    assert.equal(
      await store.markComplete(
        alreadyDone,
        { filename: 'x.mp4', filesize: 1 },
        { onlyIfDownloading: true },
      ),
      false,
    );
    assert.equal(
      await store.markComplete(
        id('missing'),
        { filename: 'x.mp4', filesize: 1 },
        { onlyIfDownloading: true },
      ),
      false,
    );
  });

  it('downloadingIds returns only rows currently downloading', async () => {
    const store = await freshStore();
    const [a, b, c] = [id('a'), id('b'), id('c')];
    await store.insert({ downloadId: a, userId: USER, filesize: 100 });
    await seedComplete(store, b, USER, 100);
    await store.insert({ downloadId: c, userId: USER, filesize: 100 });

    assert.deepEqual(namesOf(await store.downloadingIds()), ['a', 'c']);
  });

  it('failStale retires downloads stranded by a restart, sparing recent ones', async () => {
    const store = await freshStore();
    const [fresh, stranded] = [id('fresh'), id('stranded')];
    await store.insert({ downloadId: fresh, userId: USER, filesize: 100 });
    await store.insert({ downloadId: stranded, userId: USER, filesize: 100 });
    await backdate(store, stranded, { createdAt: new Date(Date.now() - 10 * HOUR) });

    assert.equal(await store.failStale(6 * HOUR), 1);
    assert.equal((await store.findForUser(stranded, USER)).status, 'failed');
    assert.equal((await store.findForUser(fresh, USER)).status, 'downloading');
    // The stranded row stops occupying the quota.
    assert.equal(await store.usageForUser(USER), 100);
  });

  // --- supersedeForUser (0XC-10: one row per canonical video identity) -------

  const SRC = 'https://example.com/watch?v=abc';
  const OTHER_FORM = 'https://youtu.be/abc?si=xyz';
  const KEY = 'youtube:abc';

  it('supersedeForUser drops the user’s older rows for the same URL', async () => {
    const store = await freshStore();
    const [old, alsoOld, fresh] = [id('old'), id('alsoOld'), id('fresh')];
    await seedComplete(store, old, USER, 100, { url: SRC });
    await store.expireForUser(old, USER);
    await seedComplete(store, alsoOld, USER, 100, { url: SRC }); // still live — superseded too
    await seedComplete(store, fresh, USER, 100, { url: SRC });

    const gone = await store.supersedeForUser({ downloadId: fresh, userId: USER, url: SRC });

    assert.deepEqual(namesOf(gone), ['alsoOld', 'old']);
    assert.deepEqual(
      (await store.listByUser(USER)).map((row) => nameOf(row.downloadId)),
      ['fresh'],
    );
  });

  it('supersedeForUser spares moved-to-cloud rows', async () => {
    const store = await freshStore();
    const [cloud, fresh] = [id('cloud'), id('fresh')];
    await seedComplete(store, cloud, USER, 100, { url: SRC });
    await store.markMoved(cloud, { provider: 'dropbox' });
    await seedComplete(store, fresh, USER, 100, { url: SRC });

    assert.deepEqual(
      await store.supersedeForUser({ downloadId: fresh, userId: USER, url: SRC }),
      [],
    );
    assert.ok(await store.findForUser(cloud, USER));
  });

  it('supersedeForUser spares an in-flight download of the same URL', async () => {
    const store = await freshStore();
    const [inflight, fresh] = [id('inflight'), id('fresh')];
    await store.insert({ downloadId: inflight, userId: USER, url: SRC, filesize: 100 });
    await seedComplete(store, fresh, USER, 100, { url: SRC });

    assert.deepEqual(
      await store.supersedeForUser({ downloadId: fresh, userId: USER, url: SRC }),
      [],
    );
    assert.equal((await store.findForUser(inflight, USER)).status, 'downloading');
  });

  it('supersedeForUser never touches another user’s rows or a different URL', async () => {
    const store = await freshStore();
    const [theirs, otherVideo, fresh] = [id('theirs'), id('otherVideo'), id('fresh')];
    await seedComplete(store, theirs, OTHER, 100, { url: SRC });
    await seedComplete(store, otherVideo, USER, 100, { url: 'https://example.com/watch?v=zzz' });
    await seedComplete(store, fresh, USER, 100, { url: SRC });

    assert.deepEqual(
      await store.supersedeForUser({ downloadId: fresh, userId: USER, url: SRC }),
      [],
    );
    assert.ok(await store.findForUser(theirs, OTHER));
    assert.ok(await store.findForUser(otherVideo, USER));
  });

  it('supersedeForUser frees the superseded rows’ quota', async () => {
    const store = await freshStore();
    const [old, fresh] = [id('old'), id('fresh')];
    await seedComplete(store, old, USER, 100, { url: SRC });
    await seedComplete(store, fresh, USER, 100, { url: SRC });
    assert.equal(await store.usageForUser(USER), 200);

    await store.supersedeForUser({ downloadId: fresh, userId: USER, url: SRC });
    assert.equal(await store.usageForUser(USER), 100);
  });

  it('supersedeForUser with no URL matches nothing', async () => {
    const store = await freshStore();
    const old = id('old');
    await seedComplete(store, old, USER, 100, { url: SRC });

    // A download whose URL never made it into the row can't identify anything to
    // replace — it must not fall through and delete the user's whole history.
    assert.deepEqual(await store.supersedeForUser({ downloadId: id('fresh'), userId: USER }), []);
    assert.ok(await store.findForUser(old, USER));
  });

  // 0XC-117: a source_key match wins over a differing raw URL, so pasting the
  // same video in another link form still supersedes the old row.

  it('supersedeForUser matches by source_key across differing URLs', async () => {
    const store = await freshStore();
    const [old, fresh] = [id('old'), id('fresh')];
    await seedComplete(store, old, USER, 100, { url: SRC, sourceKey: KEY });
    await seedComplete(store, fresh, USER, 100, { url: OTHER_FORM, sourceKey: KEY });

    const gone = await store.supersedeForUser({
      downloadId: fresh,
      userId: USER,
      url: OTHER_FORM,
      sourceKey: KEY,
    });

    assert.deepEqual(namesOf(gone), ['old']);
  });

  it('supersedeForUser falls back to url when the fresh row has no source_key', async () => {
    const store = await freshStore();
    const old = id('old');
    await seedComplete(store, old, USER, 100, { url: SRC, sourceKey: KEY });

    const gone = await store.supersedeForUser({
      downloadId: id('fresh'),
      userId: USER,
      url: SRC,
      sourceKey: null,
    });

    assert.deepEqual(namesOf(gone), ['old']);
  });

  it('supersedeForUser falls back to url when the old row predates the column', async () => {
    const store = await freshStore();
    const old = id('old');
    await seedComplete(store, old, USER, 100, { url: SRC }); // no source_key — pre-migration row

    const gone = await store.supersedeForUser({
      downloadId: id('fresh'),
      userId: USER,
      url: SRC,
      sourceKey: KEY,
    });

    assert.deepEqual(namesOf(gone), ['old']);
  });

  it('supersedeForUser does not match a different video, even at the same URL', async () => {
    const store = await freshStore();
    const old = id('old');
    await seedComplete(store, old, USER, 100, { url: SRC, sourceKey: 'youtube:zzz' });

    const gone = await store.supersedeForUser({
      downloadId: id('fresh'),
      userId: USER,
      url: SRC,
      sourceKey: KEY,
    });

    assert.deepEqual(gone, []);
    assert.ok(await store.findForUser(old, USER));
  });

  it('supersedeForUser by source_key never crosses users', async () => {
    const store = await freshStore();
    const theirs = id('theirs');
    await seedComplete(store, theirs, OTHER, 100, { url: OTHER_FORM, sourceKey: KEY });

    const gone = await store.supersedeForUser({
      downloadId: id('fresh'),
      userId: USER,
      url: SRC,
      sourceKey: KEY,
    });

    assert.deepEqual(gone, []);
    assert.ok(await store.findForUser(theirs, OTHER));
  });
}

module.exports = { runDownloadsStoreContract, USER, OTHER };
