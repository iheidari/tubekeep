const fs = require('node:fs');
const { Dropbox } = require('dropbox');

// --- Dropbox "Move to cloud" provider -------------------------------------
// Implements the CloudProvider shape consumed by services/cloud/index.js:
//   isEnabled / getPublicConfig / exchangeCode / refresh / upload
//
// OAuth is PKCE from the browser + this stateless relay for the code/refresh
// exchange (the app secret never leaves the server). The SDK is used for the
// actual chunked upload sessions and account lookup. We persist nothing.

const TOKEN_ENDPOINT = 'https://api.dropboxapi.com/oauth2/token';

// Dropbox allows a 150 MB single-shot upload, but 8 MB is the documented sweet
// spot for streaming; anything larger goes through an upload session.
const CHUNK_SIZE = 8 * 1024 * 1024;

const APP_KEY = process.env.DROPBOX_APP_KEY;
const APP_SECRET = process.env.DROPBOX_APP_SECRET;
const REDIRECT_URI = process.env.DROPBOX_REDIRECT_URI;
// The app-folder name under /Apps/<name>/ — only used to build the "Open in
// Dropbox" web deep link (needs no extra scope). Defaults to the app name.
const APP_FOLDER = process.env.DROPBOX_APP_FOLDER || 'Tubekeep';

function isEnabled() {
  return Boolean(APP_KEY && APP_SECRET && REDIRECT_URI);
}

// Public, non-secret config the frontend may read to render the connect popup.
function getPublicConfig() {
  return { appKey: APP_KEY, redirectUri: REDIRECT_URI };
}

// A CloudError carries a machine-readable `code` so the route/UI can react
// (e.g. quota → offer "download instead", auth → prompt reconnect).
class CloudError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

async function postToken(params) {
  const res = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params).toString(),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    // Never log the code/verifier/token; only the opaque Dropbox error slug.
    const slug = body.error_description || body.error || `HTTP ${res.status}`;
    throw new CloudError('oauth', `Dropbox token exchange failed: ${slug}`);
  }
  return body;
}

async function getAccount(accessToken) {
  const dbx = new Dropbox({ accessToken, fetch });
  const { result } = await dbx.usersGetCurrentAccount();
  return {
    name: result?.name?.display_name || null,
    email: result?.email || null,
  };
}

// authorization-code → tokens. Uses PKCE (code_verifier) AND the app secret;
// Dropbox accepts both for a confidential client.
async function exchangeCode({ code, codeVerifier, redirectUri }) {
  const body = await postToken({
    grant_type: 'authorization_code',
    code,
    code_verifier: codeVerifier,
    client_id: APP_KEY,
    client_secret: APP_SECRET,
    redirect_uri: redirectUri || REDIRECT_URI,
  });

  let account = null;
  try {
    account = await getAccount(body.access_token);
  } catch {
    // Account display is cosmetic — don't fail the connect over it.
  }

  return {
    accessToken: body.access_token,
    refreshToken: body.refresh_token || null,
    expiresIn: body.expires_in || null,
    account,
  };
}

// refresh-token → fresh access token (Dropbox does not rotate the refresh token).
async function refresh({ refreshToken }) {
  const body = await postToken({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: APP_KEY,
    client_secret: APP_SECRET,
  });
  return {
    accessToken: body.access_token,
    expiresIn: body.expires_in || null,
  };
}

// Map an SDK/HTTP error to a friendly CloudError the UI can branch on.
function classifyUploadError(err) {
  const status = err?.status;
  if (status === 401) {
    return new CloudError('auth', 'Dropbox session expired — please reconnect.');
  }
  // Dropbox surfaces quota problems as insufficient_space (often HTTP 507).
  const summary =
    err?.error?.error_summary ||
    err?.error?.error?.reason?.['.tag'] ||
    JSON.stringify(err?.error || '');
  if (status === 507 || /insufficient_space|no_write_permission/.test(summary)) {
    return new CloudError('quota', 'Not enough space in your Dropbox for this file.');
  }
  return new CloudError('upload', `Dropbox upload failed: ${summary || err?.message || 'unknown'}`);
}

// Retry a single chunk request on transient (5xx/network) failures only; auth
// and quota errors are terminal and must surface immediately.
async function withRetry(fn, { signal }) {
  const MAX = 3;
  let lastErr;
  for (let attempt = 1; attempt <= MAX; attempt++) {
    if (signal?.aborted) throw new CloudError('aborted', 'Upload cancelled');
    try {
      return await fn();
    } catch (err) {
      const status = err?.status;
      const transient = !status || status >= 500;
      lastErr = err;
      if (!transient || attempt === MAX) throw err;
      await new Promise((r) => setTimeout(r, 500 * 2 ** (attempt - 1)));
    }
  }
  throw lastErr;
}

// Upload a single file to the app folder, streaming from disk in CHUNK_SIZE
// slices and reporting fractional progress. Small files use a single-shot
// upload; larger ones use an upload session. Returns { path, name, link }.
async function upload({ accessToken, filePath, fileName, size, onProgress, signal }) {
  const dbx = new Dropbox({ accessToken, fetch });
  const dropboxPath = `/${fileName}`;
  const total = typeof size === 'number' ? size : fs.statSync(filePath).size;
  const commit = { path: dropboxPath, mode: 'add', autorename: true, mute: true };

  const report = (uploaded) => {
    if (typeof onProgress === 'function') {
      onProgress(total > 0 ? Math.min(100, (uploaded / total) * 100) : 100);
    }
  };

  try {
    let result;

    if (total <= CHUNK_SIZE) {
      const contents = await fs.promises.readFile(filePath);
      if (signal?.aborted) throw new CloudError('aborted', 'Upload cancelled');
      const res = await withRetry(() => dbx.filesUpload({ ...commit, contents }), { signal });
      result = res.result;
      report(total);
    } else {
      const handle = await fs.promises.open(filePath, 'r');
      try {
        const buffer = Buffer.allocUnsafe(CHUNK_SIZE);
        let offset = 0;

        // First chunk opens the session.
        let read = await handle.read(buffer, 0, CHUNK_SIZE, 0);
        let chunk = buffer.subarray(0, read.bytesRead);
        const startRes = await withRetry(
          () => dbx.filesUploadSessionStart({ close: false, contents: chunk }),
          { signal },
        );
        const sessionId = startRes.result.session_id;
        offset += read.bytesRead;
        report(offset);

        // Middle chunks append; the final chunk is handed to finish().
        while (offset < total) {
          if (signal?.aborted) throw new CloudError('aborted', 'Upload cancelled');
          read = await handle.read(buffer, 0, CHUNK_SIZE, offset);
          chunk = buffer.subarray(0, read.bytesRead);
          const isLast = offset + read.bytesRead >= total;
          const cursor = { session_id: sessionId, offset };

          if (isLast) {
            const finishRes = await withRetry(
              () => dbx.filesUploadSessionFinish({ cursor, commit, contents: chunk }),
              { signal },
            );
            result = finishRes.result;
          } else {
            await withRetry(
              () => dbx.filesUploadSessionAppendV2({ cursor, close: false, contents: chunk }),
              { signal },
            );
          }
          offset += read.bytesRead;
          report(offset);
        }
      } finally {
        await handle.close();
      }
    }

    return {
      path: result?.path_display || dropboxPath,
      name: result?.name || fileName,
      link: `https://www.dropbox.com/home/Apps/${encodeURIComponent(APP_FOLDER)}?preview=${encodeURIComponent(result?.name || fileName)}`,
    };
  } catch (err) {
    if (err instanceof CloudError) throw err;
    throw classifyUploadError(err);
  }
}

module.exports = {
  name: 'dropbox',
  isEnabled,
  getPublicConfig,
  exchangeCode,
  refresh,
  upload,
  CloudError,
};
