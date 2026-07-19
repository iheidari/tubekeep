const fs = require('node:fs');

// --- Google Drive "Move to cloud" provider --------------------------------
// Implements the same CloudProvider shape as dropbox.js, consumed by
// services/cloud/index.js:
//   isEnabled / getPublicConfig / exchangeCode / refresh / upload
//
// OAuth is PKCE from the browser + this stateless relay for the code/refresh
// exchange (the client secret never leaves the server). Uploads go through
// Drive's resumable upload API (raw fetch — no SDK dependency). We persist
// nothing: the access token lives only for the upload's life on the job.
//
// Scope is drive.file (app-created files only) — Tubekeep can see/manage only
// the files it creates, which keeps it out of Google's sensitive-scope review.

const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const DRIVE_FILES_ENDPOINT = 'https://www.googleapis.com/drive/v3/files';
const DRIVE_UPLOAD_ENDPOINT = 'https://www.googleapis.com/upload/drive/v3/files';

// Resumable-upload chunks must be a multiple of 256 KB (except the final one).
// 8 MB (= 32 × 256 KB) matches the Dropbox provider's streaming granularity.
const CHUNK_SIZE = 8 * 1024 * 1024;

const CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const REDIRECT_URI = process.env.GOOGLE_REDIRECT_URI;
// The destination folder created/reused under the user's My Drive. Under
// drive.file we only ever see folders Tubekeep created, so this resolves to
// our own folder.
const DRIVE_FOLDER = process.env.GOOGLE_DRIVE_FOLDER || 'Tubekeep';
const FOLDER_MIME = 'application/vnd.google-apps.folder';

function isEnabled() {
  return Boolean(CLIENT_ID && CLIENT_SECRET && REDIRECT_URI);
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
    // Never log the code/verifier/token; only the opaque Google error slug.
    const slug = body.error_description || body.error || `HTTP ${res.status}`;
    throw new CloudError('oauth', `Google token exchange failed: ${slug}`);
  }
  return body;
}

// authorization-code → tokens. Uses PKCE (code_verifier) AND the client secret;
// Google's "web" client accepts both for a confidential client.
async function exchangeCode({ code, codeVerifier, redirectUri }) {
  const body = await postToken({
    grant_type: 'authorization_code',
    code,
    code_verifier: codeVerifier,
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    redirect_uri: redirectUri || REDIRECT_URI,
  });

  return {
    accessToken: body.access_token,
    refreshToken: body.refresh_token || null,
    expiresIn: body.expires_in || null,
    // A display name would need an extra userinfo scope we don't request; the
    // account label stays null (cosmetic — mirrors Dropbox's best-effort lookup).
    account: null,
  };
}

// refresh-token → fresh access token (Google does not rotate the refresh token).
async function refresh({ refreshToken }) {
  const body = await postToken({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
  });
  return {
    accessToken: body.access_token,
    expiresIn: body.expires_in || null,
  };
}

// Pull a machine-readable reason out of a Google Drive JSON error body.
function driveErrorReason(body) {
  const errors = body?.error?.errors;
  if (Array.isArray(errors) && errors[0]?.reason) return errors[0].reason;
  return body?.error?.status || body?.error?.message || '';
}

// Read a non-OK Drive API response and throw a classified CloudError (carrying
// the HTTP status so withRetry can decide whether it's transient).
async function driveError(res) {
  const body = await res.json().catch(() => ({}));
  const status = res.status;
  if (status === 401) {
    throw new CloudError('auth', 'Google session expired — please reconnect.', status);
  }
  const reason = driveErrorReason(body);
  if (status === 403 && /storageQuotaExceeded|quota/i.test(reason)) {
    throw new CloudError('quota', 'Not enough space in your Google Drive for this file.', status);
  }
  throw new CloudError(
    'upload',
    `Google Drive upload failed: ${reason || body?.error?.message || `HTTP ${status}`}`,
    status,
  );
}

// Retry a request on transient (5xx / network) failures only; auth and quota
// errors are terminal and must surface immediately (mirrors dropbox.js).
async function withRetry(fn, { signal }) {
  const MAX = 3;
  let lastErr;
  for (let attempt = 1; attempt <= MAX; attempt++) {
    if (signal?.aborted) throw new CloudError('aborted', 'Upload cancelled');
    try {
      return await fn();
    } catch (err) {
      // A cancelled upload is terminal — surface it immediately as a classified
      // CloudError rather than retrying the raw fetch AbortError (a DOMException
      // with no `.status`, which would otherwise look transient).
      if (signal?.aborted || err?.name === 'AbortError' || err?.code === 'aborted') {
        throw err instanceof CloudError ? err : new CloudError('aborted', 'Upload cancelled');
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

// Find the app's "Tubekeep" folder in My Drive, creating it if absent.
async function findOrCreateFolder(accessToken, signal) {
  const auth = { Authorization: `Bearer ${accessToken}` };
  const q = `name='${DRIVE_FOLDER}' and mimeType='${FOLDER_MIME}' and trashed=false`;
  const listUrl = `${DRIVE_FILES_ENDPOINT}?q=${encodeURIComponent(q)}&fields=files(id,name)&spaces=drive`;

  const listRes = await fetch(listUrl, { headers: auth, signal });
  if (!listRes.ok) await driveError(listRes);
  const listed = await listRes.json();
  if (listed.files?.length) return listed.files[0].id;

  const createRes = await fetch(`${DRIVE_FILES_ENDPOINT}?fields=id`, {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: DRIVE_FOLDER, mimeType: FOLDER_MIME }),
    signal,
  });
  if (!createRes.ok) await driveError(createRes);
  return (await createRes.json()).id;
}

// Open a resumable-upload session and return its session URI.
async function startSession({ accessToken, fileName, total, folderId, signal }) {
  const metadata = { name: fileName, parents: [folderId] };
  const url = `${DRIVE_UPLOAD_ENDPOINT}?uploadType=resumable&fields=id,name,webViewLink`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json; charset=UTF-8',
      'X-Upload-Content-Length': String(total),
    },
    body: JSON.stringify(metadata),
    signal,
  });
  if (!res.ok) await driveError(res);
  const location = res.headers.get('location');
  if (!location) throw new CloudError('upload', 'Google Drive did not return an upload session');
  return location;
}

// PUT one chunk to the resumable session. Returns { done, file, nextOffset }:
// `done` is true on the terminal 200/201 (carrying the file resource); on a 308
// "resume incomplete" it's false and `nextOffset` is the byte Drive wants next
// (parsed from the Range header), or null when Drive reports no stored bytes.
// Throws a classified CloudError otherwise.
async function putChunk({ sessionUri, chunk, range, signal }) {
  const res = await fetch(sessionUri, {
    method: 'PUT',
    headers: { 'Content-Range': range },
    body: chunk,
    signal,
  });
  if (res.ok) return { done: true, file: await res.json().catch(() => ({})) };
  if (res.status === 308) {
    // Range: bytes=0-<last> reports the last byte Drive has stored, so we resume
    // from there — a partial-confirmation would otherwise desync the next range.
    const match = res.headers.get('range')?.match(/bytes=0-(\d+)/);
    return { done: false, nextOffset: match ? Number(match[1]) + 1 : null };
  }
  throw await driveError(res);
}

// Upload a single file to the Tubekeep folder, streaming from disk in
// CHUNK_SIZE slices via a resumable session and reporting fractional progress.
// Returns { path, name, link }.
async function upload({ accessToken, filePath, fileName, size, onProgress, signal }) {
  const total = typeof size === 'number' ? size : fs.statSync(filePath).size;

  const report = (uploaded) => {
    if (typeof onProgress === 'function') {
      onProgress(total > 0 ? Math.min(100, (uploaded / total) * 100) : 100);
    }
  };

  const folderId = await withRetry(() => findOrCreateFolder(accessToken, signal), { signal });
  const sessionUri = await withRetry(
    () => startSession({ accessToken, fileName, total, folderId, signal }),
    { signal },
  );

  const handle = await fs.promises.open(filePath, 'r');
  let file = null;
  try {
    const buffer = Buffer.allocUnsafe(CHUNK_SIZE);
    let offset = 0;

    // A zero-byte file still needs one PUT ("bytes */0") to finalise the session.
    do {
      if (signal?.aborted) throw new CloudError('aborted', 'Upload cancelled');
      const { bytesRead } = await handle.read(buffer, 0, CHUNK_SIZE, offset);
      // total > 0 with nothing left to read means the file shrank under us
      // (truncated/removed after its size was measured) — bail instead of
      // spinning on `bytes */total` status queries until the job's hard TTL.
      if (bytesRead === 0 && total > 0 && offset < total) {
        throw new CloudError('upload', 'File is shorter than expected — it may have been removed.');
      }
      const chunk = buffer.subarray(0, bytesRead);
      const end = offset + bytesRead; // exclusive
      const range = bytesRead === 0 ? `bytes */${total}` : `bytes ${offset}-${end - 1}/${total}`;

      const {
        done,
        file: uploaded,
        nextOffset,
      } = await withRetry(() => putChunk({ sessionUri, chunk, range, signal }), { signal });

      if (done) {
        file = uploaded;
        report(total);
        break;
      }
      // Resume from the byte Drive confirmed when it reported one, else assume
      // the whole chunk landed.
      offset = nextOffset ?? end;
      report(offset);
    } while (offset < total);
  } finally {
    await handle.close();
  }

  return {
    path: file?.name || fileName,
    name: file?.name || fileName,
    link:
      file?.webViewLink || (file?.id ? `https://drive.google.com/file/d/${file.id}/view` : null),
  };
}

module.exports = {
  name: 'googledrive',
  isEnabled,
  getPublicConfig,
  exchangeCode,
  refresh,
  upload,
  CloudError,
};
