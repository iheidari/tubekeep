const path = require('node:path');
const fs = require('node:fs');

const downloadsDir = path.join(__dirname, '../../downloads');
const METADATA_FILE = 'metadata.json';

function getMetadataPath(downloadId) {
  return path.join(downloadsDir, downloadId, METADATA_FILE);
}

function saveDownloadMetadata(downloadId, metadata) {
  const metadataPath = getMetadataPath(downloadId);
  fs.writeFileSync(metadataPath, JSON.stringify(metadata, null, 2));
}

function getDownloadMetadata(downloadId) {
  const metadataPath = getMetadataPath(downloadId);
  if (fs.existsSync(metadataPath)) {
    return JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
  }
  return null;
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

    const metadata = getDownloadMetadata(entry.name);
    if (!metadata) continue;

    const dirPath = path.join(downloadsDir, entry.name);
    const files = fs.readdirSync(dirPath).filter((f) => f !== METADATA_FILE);
    downloads.push({
      downloadId: entry.name,
      ...metadata,
      files,
      expired: files.length === 0,
      path: dirPath,
    });
  }

  return downloads.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}

function getDownloadFilePath(downloadId, filename) {
  const filePath = path.join(downloadsDir, downloadId, filename);
  if (fs.existsSync(filePath)) {
    return filePath;
  }
  return null;
}

function deleteDownload(downloadId) {
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

function expireDownload(downloadId) {
  const dirPath = path.join(downloadsDir, downloadId);
  if (!fs.existsSync(dirPath)) return false;

  const files = fs.readdirSync(dirPath).filter((f) => f !== METADATA_FILE);
  for (const file of files) {
    fs.rmSync(path.join(dirPath, file), { force: true, recursive: true });
  }

  const metadata = getDownloadMetadata(downloadId);
  if (metadata) {
    metadata.expiredAt = new Date().toISOString();
    saveDownloadMetadata(downloadId, metadata);
  }
  return true;
}

function cleanupOldDownloads(maxAgeHours = 24) {
  if (!fs.existsSync(downloadsDir)) {
    return { expired: 0, expiredIds: [], errors: [] };
  }

  const now = Date.now();
  const maxAgeMs = maxAgeHours * 60 * 60 * 1000;
  const expiredIds = [];
  const errors = [];

  const dirs = fs.readdirSync(downloadsDir);

  for (const dir of dirs) {
    const dirPath = path.join(downloadsDir, dir);

    try {
      const stats = fs.statSync(dirPath);
      if (!stats.isDirectory()) continue;

      const files = fs.readdirSync(dirPath).filter((f) => f !== METADATA_FILE);
      if (files.length === 0) continue;

      const metadata = getDownloadMetadata(dir);
      if (metadata?.kept) continue;

      const createdAtMs = metadata?.createdAt
        ? new Date(metadata.createdAt).getTime()
        : stats.mtimeMs;
      const age = now - createdAtMs;

      if (age > maxAgeMs) {
        expireDownload(dir);
        expiredIds.push(dir);
      }
    } catch (err) {
      errors.push({ dir, error: err.message });
    }
  }

  return { expired: expiredIds.length, expiredIds, errors };
}

module.exports = {
  downloadsDir,
  saveDownloadMetadata,
  getDownloadMetadata,
  listDownloads,
  getDownloadFilePath,
  deleteDownload,
  expireDownload,
  setKept,
  cleanupOldDownloads,
};
