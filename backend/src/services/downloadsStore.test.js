const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createMemoryStore } = require('./downloadsStore');

const USER = '11111111-1111-1111-1111-111111111111';
const OTHER = '22222222-2222-2222-2222-222222222222';

// Seed a complete download of `size` bytes for `userId`.
async function seed(store, id, userId, size, patch = {}) {
  await store.insert({
    downloadId: id,
    userId,
    url: `https://example.com/${id}`,
    title: id,
    type: 'video',
    filesize: size,
  });
  await store.markComplete(id, { filename: `${id}.mp4`, filesize: size });
  const row = store._rows.get(id);
  Object.assign(row, patch);
}

test('listByUser returns only that user’s rows, newest first', async () => {
  const store = createMemoryStore();
  await seed(store, 'a', USER, 100);
  await seed(store, 'b', OTHER, 100);
  await seed(store, 'c', USER, 100);

  const mine = await store.listByUser(USER);
  assert.deepEqual(mine.map((r) => r.downloadId).sort(), ['a', 'c']);
  assert.equal((await store.listByUser(OTHER)).length, 1);
});

test('usage counts live rows, ignores expired / moved / failed and other users', async () => {
  const store = createMemoryStore();
  await seed(store, 'live', USER, 1000);
  await seed(store, 'gone', USER, 500, { expired: true });
  await seed(store, 'cloud', USER, 700, { moved: true });
  await seed(store, 'broken', USER, 300, { status: 'failed' });
  await seed(store, 'theirs', OTHER, 9999);

  assert.equal(await store.usageForUser(USER), 1000);
});

test('an in-flight download counts toward usage so parallel starts cannot race past the cap', async () => {
  const store = createMemoryStore();
  await store.insert({ downloadId: 'pending', userId: USER, filesize: 400, type: 'video' });
  assert.equal(await store.usageForUser(USER), 400);
});

test('expiring frees the bytes; permanent delete removes the row entirely', async () => {
  const store = createMemoryStore();
  await seed(store, 'a', USER, 800);

  assert.equal(await store.expireForUser('a', USER), true);
  assert.equal(await store.usageForUser(USER), 0);
  assert.equal((await store.findForUser('a', USER)).expired, true);

  assert.equal(await store.deleteForUser('a', USER), true);
  assert.equal(await store.findForUser('a', USER), null);
});

test('another user’s id is "not found" for every mutating operation', async () => {
  const store = createMemoryStore();
  await seed(store, 'a', USER, 800);

  assert.equal(await store.findForUser('a', OTHER), null);
  assert.equal(await store.expireForUser('a', OTHER), false);
  assert.equal(await store.setKeptForUser('a', OTHER, true), false);
  assert.equal(await store.deleteForUser('a', OTHER), false);
  // ...and the row is untouched.
  assert.equal((await store.findForUser('a', USER)).expired, false);
});

test('markComplete overwrites the client-supplied size estimate with the real one', async () => {
  const store = createMemoryStore();
  await store.insert({ downloadId: 'a', userId: USER, filesize: 100 });
  await store.markComplete('a', { filename: 'a.mp4', filesize: 12345 });

  const row = await store.findForUser('a', USER);
  assert.equal(row.size, 12345);
  assert.equal(row.filename, 'a.mp4');
  assert.equal(await store.usageForUser(USER), 12345);
});

test('a moved row exposes its cloud link as `moved` so the UI renders a Moved card', async () => {
  const store = createMemoryStore();
  await seed(store, 'a', USER, 800);
  await store.markMoved('a', { provider: 'dropbox', link: 'https://dropbox/x' });

  const row = await store.findForUser('a', USER);
  assert.equal(row.moved.provider, 'dropbox');
  assert.equal(await store.usageForUser(USER), 0);
});

test('expireMissing retires rows whose media is gone, keeping those still on disk', async () => {
  const store = createMemoryStore();
  await seed(store, 'onDisk', USER, 100);
  await seed(store, 'vanished', USER, 100);
  await store.insert({ downloadId: 'running', userId: USER, filesize: 100 });
  // Age them past the grace window (asserted separately below) so this case is
  // only about presence on disk, not about how recently the row was created.
  for (const id of ['onDisk', 'vanished', 'running']) {
    store._rows.get(id).created_at = new Date(Date.now() - 60 * 60 * 1000);
  }

  assert.equal(await store.expireMissing(['onDisk', 'running']), 1);
  assert.equal((await store.findForUser('vanished', USER)).expired, true);
  assert.equal((await store.findForUser('onDisk', USER)).expired, false);
  // An in-flight row has no media on disk yet — it must not be expired.
  assert.equal((await store.findForUser('running', USER)).expired, false);
});

test('expireMissing spares rows younger than the grace window', async () => {
  const store = createMemoryStore();
  // A download that completed *during* the sweep is absent from the directory
  // snapshot the reconcile compares against — it must not be expired on arrival.
  await seed(store, 'justLanded', USER, 100);
  await seed(store, 'longGone', USER, 100);
  store._rows.get('longGone').created_at = new Date(Date.now() - 60 * 60 * 1000);

  assert.equal(await store.expireMissing([], 10 * 60 * 1000), 1);
  assert.equal((await store.findForUser('justLanded', USER)).expired, false);
  assert.equal((await store.findForUser('longGone', USER)).expired, true);
});

test('failStale retires downloads stranded by a restart, sparing recent ones', async () => {
  const store = createMemoryStore();
  await store.insert({ downloadId: 'fresh', userId: USER, filesize: 100 });
  await store.insert({ downloadId: 'stranded', userId: USER, filesize: 100 });
  store._rows.get('stranded').created_at = new Date(Date.now() - 10 * 60 * 60 * 1000);

  assert.equal(await store.failStale(6 * 60 * 60 * 1000), 1);
  assert.equal((await store.findForUser('stranded', USER)).status, 'failed');
  assert.equal((await store.findForUser('fresh', USER)).status, 'downloading');
  // The stranded row stops occupying the quota.
  assert.equal(await store.usageForUser(USER), 100);
});
