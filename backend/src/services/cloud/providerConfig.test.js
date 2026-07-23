const { test } = require('node:test');
const assert = require('node:assert/strict');

// Both providers must publish the client id under the same field (`clientId`),
// since the frontend (lib/cloud.js) reads one common field with no per-provider
// mapping. Dropbox used to publish `appKey`; this guards against that regressing.

test('dropbox getPublicConfig publishes clientId, not appKey', () => {
  process.env.DROPBOX_APP_KEY = 'dbx-key';
  process.env.DROPBOX_APP_SECRET = 'dbx-secret';
  process.env.DROPBOX_REDIRECT_URI = 'https://app.example.com/oauth/callback';

  const dropbox = require('./dropbox');

  assert.equal(dropbox.isEnabled(), true);
  assert.deepEqual(dropbox.getPublicConfig(), {
    clientId: 'dbx-key',
    redirectUri: 'https://app.example.com/oauth/callback',
  });
});

test('googledrive getPublicConfig publishes clientId', () => {
  process.env.GOOGLE_CLIENT_ID = 'g-client';
  process.env.GOOGLE_CLIENT_SECRET = 'g-secret';
  process.env.GOOGLE_REDIRECT_URI = 'https://app.example.com/oauth/callback';

  const googledrive = require('./googledrive');

  assert.equal(googledrive.isEnabled(), true);
  assert.deepEqual(googledrive.getPublicConfig(), {
    clientId: 'g-client',
    redirectUri: 'https://app.example.com/oauth/callback',
  });
});

test('neither provider re-exports CloudError (it is shared.js-internal now)', () => {
  const dropbox = require('./dropbox');
  const googledrive = require('./googledrive');
  assert.equal(dropbox.CloudError, undefined);
  assert.equal(googledrive.CloudError, undefined);
});

test('a provider missing required env reports isEnabled: false', () => {
  delete process.env.DROPBOX_APP_KEY;
  delete process.env.DROPBOX_APP_SECRET;
  delete process.env.DROPBOX_REDIRECT_URI;
  // dropbox.js reads env vars once at module load, so re-require under an
  // isolated env by clearing the cache before this assertion.
  delete require.cache[require.resolve('./dropbox')];
  const dropbox = require('./dropbox');
  assert.equal(dropbox.isEnabled(), false);
});
