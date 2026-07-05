const path = require('node:path');
const fs = require('node:fs');

const downloadsDir = path.join(__dirname, '../../downloads');
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

function cleanupOldDownloads(maxAgeHours = 24) {
  const now = Date.now();
  const maxAgeMs = maxAgeHours * 60 * 60 * 1000;
  const expiredIds = [];
  const errors = [];

  // Reuse the single directory scanner. `expired` (no media files) and `kept`
  // downloads are already surfaced by listDownloads, so this only applies the
  // age predicate — no separate filesystem walk to keep in sync.
  for (const download of listDownloads()) {
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
  isValidDownloadId,
  saveDownloadMetadata,
  getDownloadMetadata,
  getDownload,
  listDownloads,
  getDownloadFilePath,
  ensureDownloadDir,
  deleteDownload,
  expireDownload,
  markMoved,
  setKept,
  cleanupOldDownloads,
};
