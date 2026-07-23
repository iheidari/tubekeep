const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const { CloudError, postToken, refresh, withRetry, makeProgressReporter } = require('./shared');

// Stub global.fetch per test; restored after each so other suites (which may
// hit the real network) are unaffected.
let originalFetch;

beforeEach(() => {
  originalFetch = global.fetch;
});

afterEach(() => {
  global.fetch = originalFetch;
});

function jsonResponse(status, body) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

test('postToken resolves with the parsed body on a 200', async () => {
  global.fetch = async (url, opts) => {
    assert.equal(url, 'https://example.com/token');
    assert.equal(opts.method, 'POST');
    assert.equal(opts.headers['Content-Type'], 'application/x-www-form-urlencoded');
    assert.equal(opts.body, 'grant_type=authorization_code&code=abc');
    return jsonResponse(200, { access_token: 'tok', expires_in: 3600 });
  };

  const body = await postToken(
    'https://example.com/token',
    { grant_type: 'authorization_code', code: 'abc' },
    'Dropbox',
  );
  assert.deepEqual(body, { access_token: 'tok', expires_in: 3600 });
});

test('postToken throws a classified CloudError naming the provider on a non-OK response', async () => {
  global.fetch = async () =>
    jsonResponse(400, { error: 'invalid_grant', error_description: 'Code expired' });

  await assert.rejects(
    postToken('https://example.com/token', { grant_type: 'authorization_code' }, 'Dropbox'),
    (err) => {
      assert.ok(err instanceof CloudError);
      assert.equal(err.code, 'oauth');
      assert.match(err.message, /^Dropbox token exchange failed: Code expired$/);
      return true;
    },
  );
});

test('postToken falls back to an HTTP status when the error body has no message', async () => {
  global.fetch = async () => jsonResponse(500, {});

  await assert.rejects(postToken('https://example.com/token', {}, 'Google'), (err) => {
    assert.equal(err.code, 'oauth');
    assert.match(err.message, /^Google token exchange failed: HTTP 500$/);
    return true;
  });
});

test('refresh posts a refresh_token grant and returns the new access token', async () => {
  let sentParams;
  global.fetch = async (_url, opts) => {
    sentParams = Object.fromEntries(new URLSearchParams(opts.body));
    return jsonResponse(200, { access_token: 'fresh-token', expires_in: 1800 });
  };

  const result = await refresh({
    endpoint: 'https://example.com/token',
    refreshToken: 'r-tok',
    clientId: 'client-1',
    clientSecret: 'secret-1',
    errorLabel: 'Dropbox',
  });

  assert.deepEqual(sentParams, {
    grant_type: 'refresh_token',
    refresh_token: 'r-tok',
    client_id: 'client-1',
    client_secret: 'secret-1',
  });
  assert.deepEqual(result, { accessToken: 'fresh-token', expiresIn: 1800 });
});

test('refresh defaults expiresIn to null when the provider omits it', async () => {
  global.fetch = async () => jsonResponse(200, { access_token: 'fresh-token' });

  const result = await refresh({
    endpoint: 'https://example.com/token',
    refreshToken: 'r-tok',
    clientId: 'client-1',
    clientSecret: 'secret-1',
    errorLabel: 'Google',
  });

  assert.deepEqual(result, { accessToken: 'fresh-token', expiresIn: null });
});

test('withRetry resolves on the first success without retrying', async () => {
  let calls = 0;
  const result = await withRetry(async () => {
    calls++;
    return 'ok';
  }, {});
  assert.equal(result, 'ok');
  assert.equal(calls, 1);
});

test('withRetry retries a transient (status-less) failure and then succeeds', async () => {
  let calls = 0;
  const result = await withRetry(async () => {
    calls++;
    if (calls === 1) throw new Error('network blip');
    return 'ok';
  }, {});
  assert.equal(result, 'ok');
  assert.equal(calls, 2);
});

test('withRetry does not retry a non-transient (4xx) failure', async () => {
  let calls = 0;
  const err = new CloudError('auth', 'unauthorized', 401);
  await assert.rejects(
    withRetry(async () => {
      calls++;
      throw err;
    }, {}),
    (thrown) => thrown === err,
  );
  assert.equal(calls, 1);
});

test('withRetry gives up and throws the last error after exhausting attempts', async () => {
  let calls = 0;
  const err = new Error('still down');
  await assert.rejects(
    withRetry(async () => {
      calls++;
      throw err;
    }, {}),
    (thrown) => thrown === err,
  );
  assert.equal(calls, 3);
});

test('withRetry throws a classified "aborted" CloudError immediately when the signal is already aborted', async () => {
  const controller = new AbortController();
  controller.abort();
  let calls = 0;

  await assert.rejects(
    withRetry(
      async () => {
        calls++;
      },
      { signal: controller.signal },
    ),
    (err) => {
      assert.ok(err instanceof CloudError);
      assert.equal(err.code, 'aborted');
      return true;
    },
  );
  assert.equal(calls, 0);
});

test('withRetry classifies an AbortError thrown mid-flight as "aborted" without retrying', async () => {
  let calls = 0;
  const abortError = new Error('The operation was aborted');
  abortError.name = 'AbortError';

  await assert.rejects(
    withRetry(async () => {
      calls++;
      throw abortError;
    }, {}),
    (err) => {
      assert.ok(err instanceof CloudError);
      assert.equal(err.code, 'aborted');
      return true;
    },
  );
  assert.equal(calls, 1);
});

test('makeProgressReporter reports a percentage of the known total, clamped to 100', () => {
  const seen = [];
  const report = makeProgressReporter(200, (pct) => seen.push(pct));
  report(50);
  report(200);
  report(250); // past total (e.g. a final chunk rounding up) still clamps
  assert.deepEqual(seen, [25, 100, 100]);
});

test('makeProgressReporter reports 100 when total is unknown or zero', () => {
  const seen = [];
  const report = makeProgressReporter(0, (pct) => seen.push(pct));
  report(0);
  assert.deepEqual(seen, [100]);
});

test('makeProgressReporter is a no-op when onProgress is not a function', () => {
  const report = makeProgressReporter(100, undefined);
  assert.doesNotThrow(() => report(50));
});
