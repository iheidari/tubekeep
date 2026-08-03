// Unit coverage for the OneDrive "Move to cloud" provider. Mocks global fetch
// (and, for the upload streaming path, fs.promises.open) — no real network,
// no real disk I/O. Node's built-in `node:test` mock tracker is used since
// there is no mocking library in package.json; every mock is restored with
// mock.reset() after each test so tests can't leak state into one another.

const { test, before, after, afterEach, mock } = require('node:test');
const assert = require('node:assert');
const fsPromises = require('node:fs').promises;

const MODULE_PATH = require.resolve('./onedrive');

const ENV_KEYS = ['MS_CLIENT_ID', 'MS_REDIRECT_URI'];
const originalEnv = {};
for (const key of ENV_KEYS) originalEnv[key] = process.env[key];

function setEnv(overrides) {
  for (const key of ENV_KEYS) {
    if (Object.hasOwn(overrides, key)) {
      const val = overrides[key];
      if (val === undefined) delete process.env[key];
      else process.env[key] = val;
    } else {
      delete process.env[key];
    }
  }
}

function restoreEnv() {
  for (const key of ENV_KEYS) {
    if (originalEnv[key] === undefined) delete process.env[key];
    else process.env[key] = originalEnv[key];
  }
}

// onedrive.js reads MS_CLIENT_ID / MS_REDIRECT_URI into module-level consts at
// require time, so exercising different env combinations requires a fresh
// module instance each time (cache-bust + re-require).
function freshOnedrive(overrides) {
  setEnv(overrides);
  delete require.cache[MODULE_PATH];
  return require('./onedrive');
}

after(() => {
  restoreEnv();
  delete require.cache[MODULE_PATH];
});

afterEach(() => {
  mock.reset();
});

// -----------------------------------------------------------------------
// isEnabled / getPublicConfig
// -----------------------------------------------------------------------

test('isEnabled: true when both MS_CLIENT_ID and MS_REDIRECT_URI are set', () => {
  const onedrive = freshOnedrive({
    MS_CLIENT_ID: 'client-abc',
    MS_REDIRECT_URI: 'http://localhost:5173/oauth/callback',
  });
  assert.strictEqual(onedrive.isEnabled(), true);
});

test('isEnabled: false when MS_CLIENT_ID is missing', () => {
  const onedrive = freshOnedrive({
    MS_CLIENT_ID: undefined,
    MS_REDIRECT_URI: 'http://localhost:5173/oauth/callback',
  });
  assert.strictEqual(onedrive.isEnabled(), false);
});

test('isEnabled: false when MS_REDIRECT_URI is missing', () => {
  const onedrive = freshOnedrive({
    MS_CLIENT_ID: 'client-abc',
    MS_REDIRECT_URI: undefined,
  });
  assert.strictEqual(onedrive.isEnabled(), false);
});

test('isEnabled: false when both are missing', () => {
  const onedrive = freshOnedrive({ MS_CLIENT_ID: undefined, MS_REDIRECT_URI: undefined });
  assert.strictEqual(onedrive.isEnabled(), false);
});

test('getPublicConfig: returns clientId/redirectUri from env, nothing else secret', () => {
  const onedrive = freshOnedrive({
    MS_CLIENT_ID: 'client-abc',
    MS_REDIRECT_URI: 'http://localhost:5173/oauth/callback',
  });
  assert.deepStrictEqual(onedrive.getPublicConfig(), {
    clientId: 'client-abc',
    redirectUri: 'http://localhost:5173/oauth/callback',
  });
});

// -----------------------------------------------------------------------
// Shared fixture for the behavior tests below: a fixed, known env so the
// module's captured CLIENT_ID/REDIRECT_URI are deterministic.
// -----------------------------------------------------------------------

const CLIENT_ID = 'client-abc';
const REDIRECT_URI = 'http://localhost:5173/oauth/callback';
let onedrive;

before(() => {
  onedrive = freshOnedrive({ MS_CLIENT_ID: CLIENT_ID, MS_REDIRECT_URI: REDIRECT_URI });
});

function fakeResponse({ ok, status, json, headers = {} }) {
  return {
    ok,
    status,
    json: async () => json,
    headers: {
      get: (name) => {
        const key = name.toLowerCase();
        for (const [k, v] of Object.entries(headers)) {
          if (k.toLowerCase() === key) return v;
        }
        return null;
      },
    },
  };
}

// Queue-based fetch stub: each call to fetch() shifts the next canned
// response off the queue (regardless of url/options), recording every call
// for inspection.
function mockFetchQueue(responses) {
  const calls = [];
  const queue = [...responses];
  mock.method(globalThis, 'fetch', async (url, options) => {
    calls.push({ url, options });
    if (queue.length === 0) throw new Error('mockFetchQueue: no more canned responses');
    const next = queue.shift();
    if (typeof next === 'function') return next(url, options);
    return next;
  });
  return calls;
}

// -----------------------------------------------------------------------
// exchangeCode
// -----------------------------------------------------------------------

test('exchangeCode: sends no client_secret in the POST body (public client)', async () => {
  const calls = mockFetchQueue([
    fakeResponse({
      ok: true,
      status: 200,
      json: {
        access_token: 'at-1',
        refresh_token: 'rt-1',
        expires_in: 3600,
      },
    }),
  ]);

  const result = await onedrive.exchangeCode({
    code: 'auth-code-1',
    codeVerifier: 'verifier-1',
  });

  assert.strictEqual(calls.length, 1);
  const [{ url, options }] = calls;
  assert.strictEqual(url, 'https://login.microsoftonline.com/common/oauth2/v2.0/token');
  assert.strictEqual(options.method, 'POST');

  const sentBody = new URLSearchParams(options.body);
  assert.strictEqual(sentBody.get('grant_type'), 'authorization_code');
  assert.strictEqual(sentBody.get('code'), 'auth-code-1');
  assert.strictEqual(sentBody.get('code_verifier'), 'verifier-1');
  assert.strictEqual(sentBody.get('client_id'), CLIENT_ID);
  assert.strictEqual(sentBody.get('redirect_uri'), REDIRECT_URI);
  assert.strictEqual(sentBody.get('scope'), 'Files.ReadWrite.AppFolder offline_access');
  assert.strictEqual(
    sentBody.has('client_secret'),
    false,
    'a public client must never send a client_secret',
  );

  assert.deepStrictEqual(result, {
    accessToken: 'at-1',
    refreshToken: 'rt-1',
    expiresIn: 3600,
    account: null,
  });
});

test('exchangeCode: honors an explicit redirectUri override over the env default', async () => {
  const calls = mockFetchQueue([
    fakeResponse({ ok: true, status: 200, json: { access_token: 'at-1' } }),
  ]);
  await onedrive.exchangeCode({
    code: 'auth-code-1',
    codeVerifier: 'verifier-1',
    redirectUri: 'http://other.example/callback',
  });
  const sentBody = new URLSearchParams(calls[0].options.body);
  assert.strictEqual(sentBody.get('redirect_uri'), 'http://other.example/callback');
});

test('exchangeCode: a failed (non-OK) exchange throws a CloudError with code "oauth"', async () => {
  mockFetchQueue([
    fakeResponse({
      ok: false,
      status: 400,
      json: { error: 'invalid_grant', error_description: 'code expired' },
    }),
  ]);

  await assert.rejects(
    () => onedrive.exchangeCode({ code: 'bad-code', codeVerifier: 'v' }),
    (err) => {
      assert.ok(err instanceof onedrive.CloudError);
      assert.strictEqual(err.code, 'oauth');
      assert.match(err.message, /code expired/);
      return true;
    },
  );
});

test('exchangeCode: a failed exchange whose body has neither error_description nor error falls back to "HTTP <status>"', async () => {
  mockFetchQueue([fakeResponse({ ok: false, status: 500, json: {} })]);
  await assert.rejects(
    () => onedrive.exchangeCode({ code: 'bad-code', codeVerifier: 'v' }),
    (err) => {
      assert.strictEqual(err.code, 'oauth');
      assert.match(err.message, /HTTP 500/);
      return true;
    },
  );
});

// -----------------------------------------------------------------------
// refresh
// -----------------------------------------------------------------------

test('refresh: success path returns the new access token and (rotated) refresh token', async () => {
  mockFetchQueue([
    fakeResponse({
      ok: true,
      status: 200,
      json: { access_token: 'at-new', refresh_token: 'rt-new', expires_in: 1800 },
    }),
  ]);
  const result = await onedrive.refresh({ refreshToken: 'rt-old' });
  assert.deepStrictEqual(result, {
    accessToken: 'at-new',
    refreshToken: 'rt-new',
    expiresIn: 1800,
  });
});

test('refresh: falls back to the old refresh token when Microsoft does not return a new one', async () => {
  mockFetchQueue([
    fakeResponse({
      ok: true,
      status: 200,
      json: { access_token: 'at-new', expires_in: 1800 }, // no refresh_token
    }),
  ]);
  const result = await onedrive.refresh({ refreshToken: 'rt-old' });
  assert.strictEqual(result.refreshToken, 'rt-old');
  assert.strictEqual(result.accessToken, 'at-new');
});

test('refresh: sends no client_secret either', async () => {
  const calls = mockFetchQueue([
    fakeResponse({ ok: true, status: 200, json: { access_token: 'x' } }),
  ]);
  await onedrive.refresh({ refreshToken: 'rt-old' });
  const sentBody = new URLSearchParams(calls[0].options.body);
  assert.strictEqual(sentBody.get('grant_type'), 'refresh_token');
  assert.strictEqual(sentBody.get('refresh_token'), 'rt-old');
  assert.strictEqual(sentBody.get('scope'), 'Files.ReadWrite.AppFolder offline_access');
  assert.strictEqual(sentBody.has('client_secret'), false);
});

// -----------------------------------------------------------------------
// Error classification (via upload()'s createUploadSession call, which is
// the simplest path that reaches graphError())
// -----------------------------------------------------------------------

function mockUploadSessionError(response, copies = 1) {
  return mockFetchQueue(Array(copies).fill(response));
}

// Shared args for the error-classification tests below: none of them care
// about the file's identity, only how upload() reacts to the session's error.
const UPLOAD_ARGS = { accessToken: 'at', filePath: '/tmp/whatever', fileName: 'f.mp4', size: 10 };

test('error classification: a 401 response classifies as CloudError code "auth"', async () => {
  mockUploadSessionError(
    fakeResponse({
      ok: false,
      status: 401,
      json: { error: { code: 'InvalidAuthenticationToken' } },
    }),
  );
  await assert.rejects(
    () => onedrive.upload(UPLOAD_ARGS),
    (err) => {
      assert.ok(err instanceof onedrive.CloudError);
      assert.strictEqual(err.code, 'auth');
      assert.strictEqual(err.status, 401);
      return true;
    },
  );
});

test('error classification: a 507 response classifies as CloudError code "quota"', async () => {
  // withRetry treats any status >= 500 as transient (its `transient` check is
  // purely status-based, not code-aware), so a 507 gets retried MAX (3) times
  // before the classified error finally surfaces — queue enough copies to
  // survive that, or the mock runs dry before the real assertion is reached.
  mockUploadSessionError(
    fakeResponse({ ok: false, status: 507, json: { error: { code: 'insufficientStorage' } } }),
    3,
  );
  await assert.rejects(
    () => onedrive.upload(UPLOAD_ARGS),
    (err) => {
      assert.strictEqual(err.code, 'quota');
      assert.strictEqual(err.status, 507);
      return true;
    },
  );
});

test('error classification: a non-507 response whose reason matches /quota/i also classifies as "quota"', async () => {
  mockUploadSessionError(
    fakeResponse({ ok: false, status: 403, json: { error: { code: 'quotaLimitReached' } } }),
  );
  await assert.rejects(
    () => onedrive.upload(UPLOAD_ARGS),
    (err) => {
      assert.strictEqual(err.code, 'quota');
      assert.strictEqual(err.status, 403);
      return true;
    },
  );
});

test('error classification: anything else classifies as CloudError code "upload"', async () => {
  mockUploadSessionError(
    fakeResponse({ ok: false, status: 400, json: { error: { message: 'Bad request thing' } } }),
  );
  await assert.rejects(
    () => onedrive.upload(UPLOAD_ARGS),
    (err) => {
      assert.strictEqual(err.code, 'upload');
      assert.strictEqual(err.status, 400);
      assert.match(err.message, /Bad request thing/);
      return true;
    },
  );
});

// -----------------------------------------------------------------------
// upload()
// -----------------------------------------------------------------------

// Stubs fs.promises.open so upload() streams from an in-memory sequence of
// chunks rather than needing a real file on disk sized to match.
function mockFileChunks(chunks) {
  let idx = 0;
  const opened = [];
  mock.method(fsPromises, 'open', async (filePath) => {
    opened.push(filePath);
    return {
      async read(buffer, offset, length, _position) {
        if (idx >= chunks.length) return { bytesRead: 0 };
        const chunk = chunks[idx++];
        chunk.copy(buffer, offset, 0, Math.min(chunk.length, length));
        return { bytesRead: chunk.length };
      },
      async close() {},
    };
  });
  return opened;
}

test('upload(): happy path over two chunks (202 then 200) returns { path, name, link } and well-formed Content-Range headers', async () => {
  const chunkA = Buffer.alloc(6, 'a');
  const chunkB = Buffer.alloc(4, 'b');
  const total = chunkA.length + chunkB.length; // 10

  mockFileChunks([chunkA, chunkB]);

  const calls = mockFetchQueue([
    // 1) createUploadSession
    fakeResponse({
      ok: true,
      status: 200,
      json: { uploadUrl: 'https://upload.example/session-1' },
    }),
    // 2) first chunk PUT -> accepted, not done
    fakeResponse({ ok: false, status: 202, json: {} }),
    // 3) final chunk PUT -> done, carries the driveItem
    fakeResponse({
      ok: true,
      status: 200,
      json: { name: 'final-name.mp4', webUrl: 'https://onedrive.example/final-name.mp4' },
    }),
  ]);

  const progressSamples = [];
  const result = await onedrive.upload({
    accessToken: 'at',
    filePath: '/tmp/does-not-matter.mp4',
    fileName: 'f.mp4',
    size: total,
    onProgress: (pct) => progressSamples.push(pct),
  });

  assert.deepStrictEqual(result, {
    path: 'final-name.mp4',
    name: 'final-name.mp4',
    link: 'https://onedrive.example/final-name.mp4',
  });

  // calls[0] = createUploadSession, calls[1]/[2] = the two chunk PUTs
  assert.strictEqual(calls.length, 3);
  assert.match(calls[0].url, /createUploadSession$/);
  assert.strictEqual(calls[0].options.method, 'POST');
  assert.strictEqual(calls[0].options.headers.Authorization, 'Bearer at');

  const [, putA, putB] = calls;
  assert.strictEqual(putA.url, 'https://upload.example/session-1');
  assert.strictEqual(putA.options.method, 'PUT');
  assert.strictEqual(
    putA.options.headers['Content-Range'],
    `bytes 0-${chunkA.length - 1}/${total}`,
  );
  assert.strictEqual(putA.options.headers['Content-Length'], String(chunkA.length));
  // Chunk PUTs are pre-authorized by the upload URL itself, no Authorization header.
  assert.strictEqual(putA.options.headers.Authorization, undefined);

  assert.strictEqual(
    putB.options.headers['Content-Range'],
    `bytes ${chunkA.length}-${total - 1}/${total}`,
  );

  assert.ok(progressSamples.length >= 2);
  assert.strictEqual(progressSamples.at(-1), 100);
});

test('upload(): zero-byte file sends Content-Range "bytes 0-0/0", not a malformed negative range', async () => {
  mockFileChunks([Buffer.alloc(0)]);

  const calls = mockFetchQueue([
    fakeResponse({
      ok: true,
      status: 200,
      json: { uploadUrl: 'https://upload.example/session-2' },
    }),
    fakeResponse({
      ok: true,
      status: 201,
      json: { name: 'empty.txt', webUrl: 'https://onedrive.example/empty.txt' },
    }),
  ]);

  const result = await onedrive.upload({
    accessToken: 'at',
    filePath: '/tmp/empty.txt',
    fileName: 'empty.txt',
    size: 0,
  });

  assert.strictEqual(calls.length, 2);
  const putCall = calls[1];
  assert.strictEqual(putCall.options.headers['Content-Range'], 'bytes 0-0/0');
  assert.strictEqual(putCall.options.headers['Content-Length'], '0');

  assert.deepStrictEqual(result, {
    path: 'empty.txt',
    name: 'empty.txt',
    link: 'https://onedrive.example/empty.txt',
  });
});

test('upload(): when startSession returns no uploadUrl, throws a "upload" CloudError after exactly one attempt', async () => {
  mockFileChunks([Buffer.alloc(4)]);
  // This CloudError carries the response's real (non-5xx) status, so
  // withRetry's transient check (`!status || status >= 500`) treats it as
  // terminal — a single canned response is enough; queueing more would mask a
  // regression that made this retry again.
  const calls = mockFetchQueue([fakeResponse({ ok: true, status: 200, json: {} })]);
  await assert.rejects(
    () =>
      onedrive.upload({
        accessToken: 'at',
        filePath: '/tmp/x',
        fileName: 'x.mp4',
        size: 4,
      }),
    (err) => {
      assert.ok(err instanceof onedrive.CloudError);
      assert.strictEqual(err.code, 'upload');
      assert.match(err.message, /did not return an upload session/);
      return true;
    },
  );
  assert.strictEqual(calls.length, 1, 'a non-5xx malformed response must not be retried');
});

test('upload(): a transient 5xx on createUploadSession is retried and then succeeds', async () => {
  mockFileChunks([Buffer.alloc(4)]);
  const calls = mockFetchQueue([
    fakeResponse({ ok: false, status: 503, json: {} }),
    fakeResponse({
      ok: true,
      status: 200,
      json: { uploadUrl: 'https://upload.example/session-3' },
    }),
    fakeResponse({
      ok: true,
      status: 200,
      json: { name: 'r.mp4', webUrl: 'https://onedrive.example/r.mp4' },
    }),
  ]);

  const result = await onedrive.upload({
    accessToken: 'at',
    filePath: '/tmp/r.mp4',
    fileName: 'r.mp4',
    size: 4,
  });

  assert.strictEqual(calls.length, 3);
  assert.deepStrictEqual(result, {
    path: 'r.mp4',
    name: 'r.mp4',
    link: 'https://onedrive.example/r.mp4',
  });
});

test('upload(): if the last chunk PUT never returns a terminal response (always 202), throws instead of silently reporting success', async () => {
  mockFileChunks([Buffer.alloc(4)]);
  mockFetchQueue([
    fakeResponse({
      ok: true,
      status: 200,
      json: { uploadUrl: 'https://upload.example/session-4' },
    }),
    // The one and only chunk PUT is "accepted" but never finalizes.
    fakeResponse({ ok: false, status: 202, json: {} }),
  ]);

  await assert.rejects(
    () =>
      onedrive.upload({
        accessToken: 'at',
        filePath: '/tmp/never-done.mp4',
        fileName: 'never-done.mp4',
        size: 4,
      }),
    (err) => {
      assert.ok(err instanceof onedrive.CloudError);
      assert.strictEqual(err.code, 'upload');
      assert.match(err.message, /did not confirm the upload finished/);
      return true;
    },
  );
});

test('upload(): an already-aborted signal fails fast with no fetch calls', async () => {
  mockFileChunks([Buffer.alloc(4)]);
  const calls = mockFetchQueue([
    fakeResponse({
      ok: true,
      status: 200,
      json: { uploadUrl: 'https://upload.example/session-5' },
    }),
  ]);
  const controller = new AbortController();
  controller.abort();

  await assert.rejects(
    () =>
      onedrive.upload({
        accessToken: 'at',
        filePath: '/tmp/x.mp4',
        fileName: 'x.mp4',
        size: 4,
        signal: controller.signal,
      }),
    (err) => {
      assert.ok(err instanceof onedrive.CloudError);
      assert.strictEqual(err.code, 'aborted');
      return true;
    },
  );
  assert.strictEqual(
    calls.length,
    0,
    'an already-aborted signal must not even attempt createUploadSession',
  );
});
