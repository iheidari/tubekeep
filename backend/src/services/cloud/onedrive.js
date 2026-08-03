const fs = require('node:fs');

// --- OneDrive "Move to cloud" provider -------------------------------------
// Implements the same CloudProvider shape as dropbox.js / googledrive.js,
// consumed by services/cloud/index.js:
//   isEnabled / getPublicConfig / exchangeCode / refresh / upload
//
// Unlike Dropbox/Google Drive, this is a **public client** — Microsoft Graph's
// `common` authority supports PKCE-only auth-code exchange with no client
// secret, so there is nothing confidential to keep server-side beyond the
// access/refresh tokens themselves (which, like the other providers, we never
// persist — they live only for the upload's life on the job).
//
// Uploads land in the app-only special folder (`/me/drive/special/approot`)
// under the `Files.ReadWrite.AppFolder` scope — minimal consent, no visibility
// into the rest of the user's OneDrive.

const TOKEN_ENDPOINT = 'https://login.microsoftonline.com/common/oauth2/v2.0/token';
const UPLOAD_SESSION_ENDPOINT = (fileName) =>
  `https://graph.microsoft.com/v1.0/me/drive/special/approot:/${encodeURIComponent(fileName)}:/createUploadSession`;

// Graph requires resumable-upload chunks to be a multiple of 320 KiB (except
// the final one). 10 MiB (= 32 × 320 KiB) matches the other providers' chunk
// granularity while staying an exact multiple.
const CHUNK_UNIT = 320 * 1024;
const CHUNK_SIZE = 32 * CHUNK_UNIT; // 10 MiB

const CLIENT_ID = process.env.MS_CLIENT_ID;
const REDIRECT_URI = process.env.MS_REDIRECT_URI;
// Both personal and work/school accounts use scope Files.ReadWrite.AppFolder;
// offline_access is required to receive a refresh token.
const SCOPE = 'Files.ReadWrite.AppFolder offline_access';

function isEnabled() {
  return Boolean(CLIENT_ID && REDIRECT_URI);
}

// Public, non-secret config the frontend may read to render the connect popup.
function getPublicConfig() {
  return { clientId: CLIENT_ID, redirectUri: REDIRECT_URI };
}

// A CloudError carries a machine-readable `code` so the route/UI can react
// (e.g. quota → offer "download instead", auth → prompt reconnect). `status`
// (when set) is the originating HTTP status, used to decide retry-ability.
class CloudError extends Error {
  constructor(code, message, status) {
    super(message);
    this.code = code;
    this.status = status;
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
    // Never log the code/verifier/token; only the opaque Microsoft error slug.
    const slug = body.error_description || body.error || `HTTP ${res.status}`;
    throw new CloudError('oauth', `OneDrive token exchange failed: ${slug}`);
  }
  return body;
}

// authorization-code → tokens. PKCE only — a public client sends no
// client_secret; Graph's `common` authority accepts both personal (MSA) and
// work/school (Entra ID) accounts through the same endpoint.
async function exchangeCode({ code, codeVerifier, redirectUri }) {
  const body = await postToken({
    grant_type: 'authorization_code',
    code,
    code_verifier: codeVerifier,
    client_id: CLIENT_ID,
    redirect_uri: redirectUri || REDIRECT_URI,
    scope: SCOPE,
  });

  return {
    accessToken: body.access_token,
    refreshToken: body.refresh_token || null,
    expiresIn: body.expires_in || null,
    // A display name would need an extra Graph call (/me) we don't otherwise
    // need — the account label stays null (cosmetic — mirrors Google Drive).
    account: null,
  };
}

// refresh-token → fresh access token. Microsoft may rotate the refresh token
// on use, so callers must persist the one this returns going forward.
async function refresh({ refreshToken }) {
  const body = await postToken({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: CLIENT_ID,
    scope: SCOPE,
  });
  return {
    accessToken: body.access_token,
    refreshToken: body.refresh_token || refreshToken,
    expiresIn: body.expires_in || null,
  };
}

// Pull a machine-readable reason out of a Graph JSON error body.
function graphErrorReason(body) {
  return body?.error?.code || body?.error?.message || '';
}

// Read a non-OK Graph response and throw a classified CloudError (carrying the
// HTTP status so withRetry can decide whether it's transient).
async function graphError(res) {
  const body = await res.json().catch(() => ({}));
  const status = res.status;
  if (status === 401) {
    throw new CloudError('auth', 'OneDrive session expired — please reconnect.', status);
  }
  const reason = graphErrorReason(body);
  if (status === 507 || /quota/i.test(reason)) {
    throw new CloudError('quota', 'Not enough space in your OneDrive for this file.', status);
  }
  throw new CloudError('upload', `OneDrive upload failed: ${reason || `HTTP ${status}`}`, status);
}

// Retry a request on transient (5xx / network) failures only; auth and quota
// errors are terminal and must surface immediately (mirrors the other providers).
async function withRetry(fn, { signal }) {
  const MAX = 3;
  let lastErr;
  for (let attempt = 1; attempt <= MAX; attempt++) {
    if (signal?.aborted) throw new CloudError('aborted', 'Upload cancelled');
    try {
      return await fn();
    } catch (err) {
      if (signal?.aborted || err?.name === 'AbortError' || err?.code === 'aborted') {
        throw err instanceof CloudError ? err : new CloudError('aborted', 'Upload cancelled');
      }
      // auth/quota are already-classified terminal outcomes — never retry them,
      // even though Graph's quota status (507) is >= 500 and would otherwise
      // look transient to the generic status check below.
      if (err instanceof CloudError && (err.code === 'auth' || err.code === 'quota')) {
        throw err;
      }
      const status = err?.status;
      const transient = !status || status >= 500; // no status → network throw
      lastErr = err;
      if (!transient || attempt === MAX) throw err;
      await new Promise((r) => setTimeout(r, 500 * 2 ** (attempt - 1)));
    }
  }
  throw lastErr;
}

// Open a resumable-upload session in the app folder and return its upload URL.
async function startSession({ accessToken, fileName, signal }) {
  const res = await fetch(UPLOAD_SESSION_ENDPOINT(fileName), {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ item: { '@microsoft.graph.conflictBehavior': 'rename' } }),
    signal,
  });
  if (!res.ok) await graphError(res);
  const body = await res.json();
  // The request itself succeeded (res.ok) but the body is malformed — pass the
  // (non-5xx) status through so withRetry treats this as terminal rather than
  // retrying a response that will never contain an uploadUrl.
  if (!body.uploadUrl) {
    throw new CloudError('upload', 'OneDrive did not return an upload session', res.status);
  }
  return body.uploadUrl;
}

// PUT one chunk to the resumable session. Returns { done, file }: `done` is
// true on the terminal 200/201 (carrying the driveItem); on a 202 "accepted"
// it's false and the caller advances by the chunk it just sent (Graph doesn't
// echo back a byte offset to resume from the way Drive does). Throws a
// classified CloudError otherwise. The upload URL itself is pre-authorized —
// no Authorization header on chunk PUTs.
async function putChunk({ uploadUrl, chunk, range, signal }) {
  const res = await fetch(uploadUrl, {
    method: 'PUT',
    headers: { 'Content-Length': String(chunk.length), 'Content-Range': range },
    body: chunk,
    signal,
  });
  if (res.status === 200 || res.status === 201) {
    return { done: true, file: await res.json().catch(() => ({})) };
  }
  if (res.status === 202) return { done: false };
  throw await graphError(res);
}

// Upload a single file to the app folder, streaming from disk in CHUNK_SIZE
// slices via a resumable session and reporting fractional progress. Returns
// { path, name, link }.
async function upload({ accessToken, filePath, fileName, size, onProgress, signal }) {
  const total = typeof size === 'number' ? size : fs.statSync(filePath).size;

  const report = (uploaded) => {
    if (typeof onProgress === 'function') {
      onProgress(total > 0 ? Math.min(100, (uploaded / total) * 100) : 100);
    }
  };

  const uploadUrl = await withRetry(() => startSession({ accessToken, fileName, signal }), {
    signal,
  });

  const handle = await fs.promises.open(filePath, 'r');
  let file = null;
  try {
    const buffer = Buffer.allocUnsafe(CHUNK_SIZE);
    let offset = 0;

    do {
      if (signal?.aborted) throw new CloudError('aborted', 'Upload cancelled');
      const { bytesRead } = await handle.read(buffer, 0, CHUNK_SIZE, offset);
      // total > 0 with nothing left to read means the file shrank under us
      // (truncated/removed after its size was measured) — bail instead of
      // looping forever on a range Graph will never see satisfied.
      if (bytesRead === 0 && total > 0 && offset < total) {
        throw new CloudError('upload', 'File is shorter than expected — it may have been removed.');
      }
      const chunk = buffer.subarray(0, bytesRead);
      const end = offset + bytesRead; // exclusive
      // A zero-byte file never has a valid inclusive byte range — Graph's
      // documented shape for that case is "bytes 0-0/0" with an empty body.
      const range = total === 0 ? 'bytes 0-0/0' : `bytes ${offset}-${end - 1}/${total}`;

      const { done, file: uploaded } = await withRetry(
        () => putChunk({ uploadUrl, chunk, range, signal }),
        { signal },
      );

      offset = end;
      report(offset);
      if (done) {
        file = uploaded;
        break;
      }
    } while (offset < total);
  } finally {
    await handle.close();
  }

  // The loop above exits on `offset >= total`, not on ever having seen a
  // terminal (200/201) response — if Graph answered every chunk PUT with 202
  // (including the one that reached the last byte), `file` is still null here.
  // Treat that as a failure rather than reporting a move that never actually
  // finalized.
  if (!file) {
    throw new CloudError('upload', 'OneDrive did not confirm the upload finished');
  }

  return {
    path: file.name || fileName,
    name: file.name || fileName,
    link: file.webUrl || null,
  };
}

module.exports = {
  name: 'onedrive',
  isEnabled,
  getPublicConfig,
  exchangeCode,
  refresh,
  upload,
  CloudError,
};
