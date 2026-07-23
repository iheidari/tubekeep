const path = require('node:path');
const fs = require('node:fs');

// Resolve once at load time so every consumer (routes, cleanup, tests) sees the
// same absolute path. Defaults to the historical in-tree location.
const downloadsDir = path.resolve(
  process.env.DOWNLOADS_DIR || path.join(__dirname, '../../downloads'),
);
const METADATA_FILE = 'metadata.json';

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

let tmpCounter = 0;

function getMetadataPath(downloadId) {
  return path.join(downloadsDir, downloadId, METADATA_FILE);
}

function saveDownloadMetadata(downloadId, metadata) {
  if (!isValidDownloadId(downloadId)) return;
  const metadataPath = getMetadataPath(downloadId);
  // Write to a temp file and rename so a crash mid-write can't leave a
  // half-written metadata.json that breaks JSON.parse for the whole listing.
  const tmpPath = `${metadataPath}.${process.pid}.${tmpCounter++}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(metadata, null, 2));
  fs.renameSync(tmpPath, metadataPath);
}

function getDownloadMetadata(downloadId) {
  if (!isValidDownloadId(downloadId)) return null;
  const metadataPath = getMetadataPath(downloadId);
  try {
    if (fs.existsSync(metadataPath)) {
      return JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
    }
  } catch (err) {
    console.error(`⚠️  Corrupt metadata for ${downloadId}: ${err.message}`);
  }
  return null;
}

// Build the listing row for a single download: metadata + its media files, with
// `expired` derived from having no media files left. Returns null if the id is
// invalid, has no/corrupt metadata, or its directory can't be read — so callers
// (and listDownloads) can skip it without a corrupt row breaking the listing.
function getDownload(downloadId) {
  const metadata = getDownloadMetadata(downloadId);
  if (!metadata) return null;

  const dirPath = path.join(downloadsDir, downloadId);
  let files;
  try {
    files = fs.readdirSync(dirPath).filter((f) => f !== METADATA_FILE);
  } catch (err) {
    console.error(`⚠️  Skipping unreadable download ${downloadId}: ${err.message}`);
    return null;
  }

  return {
    downloadId,
    ...metadata,
    files,
    expired: files.length === 0,
    path: dirPath,
  };
}

function listDownloads() {
  let entries;
  try {
    entries = fs.readdirSync(downloadsDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const downloads = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const download = getDownload(entry.name);
    if (download) downloads.push(download);
  }

  return downloads.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
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

// Actual on-disk byte size of a download's declared result file, or null if
// it's missing (metadata names a file that isn't actually there — e.g. a
// partial download). Reuses getDownloadFilePath's validation/traversal guard,
// so callers get the same "confirmed to exist as a file" contract. Used by the
// cleanup reconcile (see cleanup.js) to trust the real file over a stale or
// client-estimated size.
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

function setKept(downloadId, kept) {
  const metadata = getDownloadMetadata(downloadId);
  if (!metadata) return false;
  metadata.kept = !!kept;
  saveDownloadMetadata(downloadId, metadata);
  return true;
}

// Drop a download's media files but KEEP metadata.json, then merge `patch` into
// the metadata. This is the shared mechanism behind both lifecycle transitions
// that retire media without hard-deleting the row: "expired" (aged out) and
// "moved" (uploaded to the visitor's cloud). The row lives on — re-downloadable
// from source — instead of the whole directory being removed by deleteDownload.
function dropMediaAndPatch(downloadId, patch) {
  if (!isValidDownloadId(downloadId)) return false;
  const dirPath = path.join(downloadsDir, downloadId);
  if (!fs.existsSync(dirPath)) return false;

  const files = fs.readdirSync(dirPath).filter((f) => f !== METADATA_FILE);
  for (const file of files) {
    fs.rmSync(path.join(dirPath, file), { force: true, recursive: true });
  }

  const metadata = getDownloadMetadata(downloadId);
  if (metadata) {
    saveDownloadMetadata(downloadId, { ...metadata, ...patch });
  }
  return true;
}

function expireDownload(downloadId) {
  return dropMediaAndPatch(downloadId, { expiredAt: new Date().toISOString() });
}

// Move-to-cloud lifecycle: the moved row keeps its source `url` + cloud link so
// it stays re-downloadable from source and openable in the visitor's cloud.
function markMoved(downloadId, moveInfo) {
  return dropMediaAndPatch(downloadId, {
    movedAt: new Date().toISOString(),
    moved: moveInfo || {},
  });
}

// `downloads` defaults to a fresh scan; callers that already hold a listing pass
// it in so one sweep doesn't walk the downloads directory twice.
// Remove download directories that carry no metadata.json and haven't been
// touched in `maxAgeMs`. Such a directory is debris, not a download: metadata is
// written on completion, so anything without it either died mid-flight or was
// recreated by a yt-dlp process still flushing after its abort was requested
// (the cancel route removes the directory synchronously, but the subprocess
// exits asynchronously). listDownloads skips these, so the age-based sweep can
// never reach them and they would sit on disk forever.
//
// `maxAgeMs` must stay well past the longest plausible download: a directory's
// mtime only changes when an entry is added or removed, so a slow single-file
// download can look untouched the whole time it is running. Callers pass the
// same window used to declare an in-flight download stranded.
function cleanupOrphanDirs(maxAgeMs = 6 * 60 * 60 * 1000) {
  let entries;
  try {
    entries = fs.readdirSync(downloadsDir, { withFileTypes: true });
  } catch {
    return { removed: 0, removedIds: [] };
  }

  const cutoff = Date.now() - maxAgeMs;
  const removedIds = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !isValidDownloadId(entry.name)) continue;
    const dirPath = path.join(downloadsDir, entry.name);
    try {
      if (fs.existsSync(path.join(dirPath, METADATA_FILE))) continue;
      if (fs.statSync(dirPath).mtimeMs >= cutoff) continue;
      fs.rmSync(dirPath, { recursive: true, force: true });
      removedIds.push(entry.name);
    } catch (err) {
      console.error(`⚠️  Could not remove orphan dir ${entry.name}: ${err.message}`);
    }
  }
  return { removed: removedIds.length, removedIds };
}

function cleanupOldDownloads(maxAgeHours = 24, downloads = listDownloads()) {
  const now = Date.now();
  const maxAgeMs = maxAgeHours * 60 * 60 * 1000;
  const expiredIds = [];
  const errors = [];

  // Reuse the single directory scanner. `expired` (no media files) and `kept`
  // downloads are already surfaced by listDownloads, so this only applies the
  // age predicate — no separate filesystem walk to keep in sync.
  for (const download of downloads) {
    if (download.expired || download.kept) continue;

    try {
      const createdAtMs = download.createdAt ? new Date(download.createdAt).getTime() : NaN;
      // Missing/invalid createdAt: leave it alone rather than expiring blindly.
      if (Number.isFinite(createdAtMs) && now - createdAtMs > maxAgeMs) {
        expireDownload(download.downloadId);
        expiredIds.push(download.downloadId);
      }
    } catch (err) {
      errors.push({ dir: download.downloadId, error: err.message });
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
  saveDownloadMetadata,
  getDownloadMetadata,
  getDownload,
  listDownloads,
  getDownloadFilePath,
  getDownloadFileSize,
  ensureDownloadDir,
  deleteDownload,
  expireDownload,
  markMoved,
  setKept,
  cleanupOldDownloads,
  cleanupOrphanDirs,
};
