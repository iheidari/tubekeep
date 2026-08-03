const path = require('node:path');
const fs = require('node:fs');

// Resolve once at load time so every consumer (routes, cleanup, tests) sees the
// same absolute path. Defaults to the historical in-tree location.
const downloadsDir = path.resolve(
  process.env.DOWNLOADS_DIR || path.join(__dirname, '../../downloads'),
);

// downloadIds are server-minted UUIDs. Anything else in a route param is an
// injection attempt — reject it before it ever reaches path.join / fs.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isValidDownloadId(downloadId) {
  return typeof downloadId === 'string' && UUID_RE.test(downloadId);
}

// Resolve `segments` under `base` and confirm the result stays inside it.
// Guards against `..` / absolute-path traversal in user-controlled segments.
function resolveWithin(base, ...segments) {
  const root = path.resolve(base);
  const target = path.resolve(root, ...segments);
  if (target !== root && !target.startsWith(root + path.sep)) return null;
  return target;
}

// Filesystem-only view of one download directory: its files and how recently
// the directory was touched (a write bumps mtime, which is what the age-based
// sweep uses in place of a stored `createdAt`). The `downloads` row — not this
// — is the source of truth for everything else (title, status, kept, …).
// Returns null if the id is invalid or the directory can't be read.
function getDownloadDir(downloadId) {
  if (!isValidDownloadId(downloadId)) return null;
  const dirPath = path.join(downloadsDir, downloadId);
  let files;
  let mtimeMs;
  try {
    files = fs.readdirSync(dirPath);
    mtimeMs = fs.statSync(dirPath).mtimeMs;
  } catch (err) {
    console.error(`⚠️  Skipping unreadable download ${downloadId}: ${err.message}`);
    return null;
  }
  return { downloadId, files, mtimeMs };
}

// True when a `getDownloadDir`/`listDownloadDirs` entry still has media to
// serve or move. An empty directory (drained by a prior expire/move, or never
// written to) has nothing left to reclaim or upload — the one "does this
// download still have files" check, shared by the age-based sweep and the
// move-to-cloud job instead of each re-deriving it from `.files.length`.
function hasMedia(dir) {
  return !!dir && dir.files.length > 0;
}

// Every download directory on disk — the raw material the cleanup sweep walks.
// Ordering doesn't matter here (unlike the old metadata-backed listing, nothing
// renders this directly); callers derive whatever order they need.
function listDownloadDirs() {
  let entries;
  try {
    entries = fs.readdirSync(downloadsDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const dirs = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !isValidDownloadId(entry.name)) continue;
    const dir = getDownloadDir(entry.name);
    if (dir) dirs.push(dir);
  }
  return dirs;
}

function getDownloadFilePath(downloadId, filename) {
  if (!isValidDownloadId(downloadId)) return null;
  // Reject any path separators / traversal in the filename before touching fs.
  if (
    typeof filename !== 'string' ||
    filename === '' ||
    filename === '.' ||
    filename === '..' ||
    filename.includes('/') ||
    filename.includes('\\')
  ) {
    return null;
  }

  const filePath = resolveWithin(downloadsDir, downloadId, filename);
  if (!filePath) return null;

  try {
    if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
      return filePath;
    }
  } catch {
    // fall through to null
  }
  return null;
}

// Actual on-disk byte size of one of a download's files, or null if it isn't
// actually there (e.g. it vanished between a directory listing and this call).
// Reuses getDownloadFilePath's validation/traversal guard, so callers get the
// same "confirmed to exist as a file" contract. Used by the cleanup reconcile
// (see cleanup.js) to trust the real file over a stale or client-estimated
// size.
function getDownloadFileSize(downloadId, filename) {
  const filePath = getDownloadFilePath(downloadId, filename);
  if (!filePath) return null;
  try {
    return fs.statSync(filePath).size;
  } catch {
    return null;
  }
}

// Create (idempotently) the per-download directory and return its path. The
// only place the download-dir layout is minted, so callers never join paths
// under downloadsDir themselves.
function ensureDownloadDir(downloadId) {
  if (!isValidDownloadId(downloadId)) {
    throw new Error(`Invalid downloadId: ${downloadId}`);
  }
  const dirPath = path.join(downloadsDir, downloadId);
  fs.mkdirSync(dirPath, { recursive: true });
  return dirPath;
}

function deleteDownload(downloadId) {
  if (!isValidDownloadId(downloadId)) return false;
  const downloadPath = path.join(downloadsDir, downloadId);
  if (fs.existsSync(downloadPath)) {
    fs.rmSync(downloadPath, { recursive: true, force: true });
    return true;
  }
  return false;
}

// Disk-space guard. A download "fits" when free space covers `DISK_SIZE_MULTIPLIER`×
// its final size plus `DISK_HEADROOM_BYTES` of slack. The 2× covers the transient
// video+audio merge (both streams sit on disk before muxing to mp4); the headroom
// is general slack. These knobs are the single source of truth for the fit math —
// GET /api/disk echoes them so the frontend disable-check uses identical numbers.
const DISK_SIZE_MULTIPLIER = 2;
const DISK_HEADROOM_BYTES = 500 * 1024 * 1024;

// Total / free / used bytes for the filesystem holding downloadsDir. `free` is
// bavail (space available to unprivileged writes), which is what a download can
// actually use — not bfree (which includes root-reserved blocks).
async function getDiskUsage() {
  const stats = await fs.promises.statfs(downloadsDir);
  const total = stats.blocks * stats.bsize;
  const free = stats.bavail * stats.bsize;
  return { total, free, used: total - free };
}

// Bytes of free space a download of `filesize` needs to clear the margin.
// Unknown/zero size needs nothing. Sole definition of the fit threshold, so the
// guard and any "need ~X" message read from the same number.
function requiredBytesFor(filesize) {
  if (!filesize || filesize <= 0) return 0;
  return filesize * DISK_SIZE_MULTIPLIER + DISK_HEADROOM_BYTES;
}

// True when `free` bytes can hold a download of `filesize` bytes within the
// margin. Unknown/zero size is always allowed (nothing to compare). Shared with
// the frontend via the knobs in the /api/disk response, so there's no drift.
function hasRoomFor(free, filesize) {
  return free >= requiredBytesFor(filesize);
}

// Sentinel `max_storage_bytes` meaning "no cap" (see schema.sql / CLAUDE.md).
const UNLIMITED_QUOTA = -1;

function isUnlimitedQuota(max) {
  const n = Number(max);
  return !Number.isFinite(n) || n < 0;
}

// Bytes a user has left before hitting their quota, or UNLIMITED_QUOTA when they
// have no cap. Never negative — an over-quota user reads as 0 remaining.
function remainingQuota(used, max) {
  if (isUnlimitedQuota(max)) return UNLIMITED_QUOTA;
  return Math.max(0, Number(max) - Number(used || 0));
}

// Per-user quota guard, the companion to hasRoomFor: `used` + `filesize` must
// stay within `max`. Unlike the disk guard there's no multiplier/headroom —
// the quota counts what a download will actually keep, not its transient merge
// footprint. Unlimited quota and unknown/zero size are always allowed (the
// latter mirrors hasRoomFor, so an unsized format is never blocked). Shared with
// the frontend via the quota block in the /api/disk response, so there's no drift.
function hasQuotaFor(used, max, filesize) {
  if (isUnlimitedQuota(max)) return true;
  if (!filesize || filesize <= 0) return true;
  return Number(used || 0) + Number(filesize) <= Number(max);
}

// Expire and move-to-cloud both retire a download's *local* media while the
// `downloads` row (the single lifecycle record) lives on — re-downloadable
// from source, or openable in the visitor's cloud. With no on-disk record left
// to preserve, both are just "the directory is gone"; kept as two named
// exports because the call sites read clearer that way, and it's cheap.
function expireDownload(downloadId) {
  return deleteDownload(downloadId);
}

function markMoved(downloadId) {
  return deleteDownload(downloadId);
}

// Age-based expiry over a set of on-disk directories (default: a fresh scan).
// Age is the directory's `mtimeMs` — the closest filesystem-only stand-in for
// "last touched" now that there's no stored `createdAt` to read. `skipIds`
// (downloads currently `kept`, and/or actively running in *this* process —
// see downloadManager's `runningDownloadIds`) is never touched regardless of
// age. Everything else — which downloads exist, whether one is `kept`,
// whether it's still running — is the caller's job to know; this function
// only ever deletes directories.
//
// This deliberately does NOT skip empty directories: one with no files is
// exactly what a download that died before any bytes landed looks like
// (`ensureDownloadDir` ran, the job never got further), and reclaiming those
// once they go stale is this function's replacement for the old, separate
// `cleanupOrphanDirs` sweep — folded in here rather than kept as a second
// pass, since both are now just "how old is this directory".
function cleanupOldDownloads(maxAgeHours = 24, { downloads = listDownloadDirs(), skipIds } = {}) {
  const now = Date.now();
  const maxAgeMs = maxAgeHours * 60 * 60 * 1000;
  const skip = skipIds || new Set();
  const expiredIds = [];
  const errors = [];

  for (const dir of downloads) {
    if (skip.has(dir.downloadId)) continue;

    try {
      if (now - dir.mtimeMs > maxAgeMs) {
        expireDownload(dir.downloadId);
        expiredIds.push(dir.downloadId);
      }
    } catch (err) {
      errors.push({ dir: dir.downloadId, error: err.message });
    }
  }

  return { expired: expiredIds.length, expiredIds, errors };
}

module.exports = {
  downloadsDir,
  DISK_SIZE_MULTIPLIER,
  DISK_HEADROOM_BYTES,
  getDiskUsage,
  hasRoomFor,
  requiredBytesFor,
  UNLIMITED_QUOTA,
  isUnlimitedQuota,
  remainingQuota,
  hasQuotaFor,
  isValidDownloadId,
  getDownloadDir,
  listDownloadDirs,
  hasMedia,
  getDownloadFilePath,
  getDownloadFileSize,
  ensureDownloadDir,
  deleteDownload,
  expireDownload,
  markMoved,
  cleanupOldDownloads,
};
