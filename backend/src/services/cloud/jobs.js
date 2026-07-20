const { EventEmitter } = require('node:events');
const { v4: uuidv4 } = require('uuid');
const { getDownload, getDownloadFilePath, markMoved } = require('../../utils/storage');
const { getProvider } = require('./index');
const fs = require('node:fs');

// In-memory upload-job manager for "Move to cloud".
//
// A job holds the visitor's access token *only for the life of the upload*
// (never persisted, cleared the moment the upload settles). The SSE route
// watches a job by its opaque id, so the token never rides in a URL.
//
// Guardrails for a public, no-auth server:
//   - MAX_CONCURRENT caps simultaneous uploads; the rest wait as 'queued'.
//   - Each job has a hard TTL so an abandoned job can't hold a token forever.

const MAX_CONCURRENT = 3;
const JOB_HARD_TTL_MS = 30 * 60 * 1000; // abort + drop a job stuck this long
const TERMINAL_LINGER_MS = 2 * 60 * 1000; // keep final state readable after finish

const jobs = new Map(); // jobId -> job
const queue = [];
let active = 0;

function snapshot(job) {
  return {
    jobId: job.jobId,
    status: job.status, // queued | uploading | complete | error
    progress: Math.round(job.progress * 10) / 10,
    error: job.error, // { code, message } | null
    result: job.result, // { provider, name, path, link } | null
  };
}

function emit(job) {
  job.emitter.emit('update', snapshot(job));
}

function fail(job, code, message) {
  job.status = 'error';
  job.error = { code, message };
  emit(job);
}

function removeJob(job) {
  clearTimeout(job.hardTtl);
  clearTimeout(job.lingerTtl);
  jobs.delete(job.jobId);
}

// Once a job settles, drop the token immediately and schedule removal after a
// short linger so a slow/reconnecting SSE client can still read the outcome.
function settle(job) {
  job.accessToken = null;
  clearTimeout(job.hardTtl);
  job.lingerTtl = setTimeout(() => removeJob(job), TERMINAL_LINGER_MS);
}

async function run(job) {
  const provider = getProvider(job.providerName);
  if (!provider) {
    fail(job, 'provider', 'Cloud provider is not available');
    return;
  }

  const record = getDownload(job.downloadId);
  if (!record || record.expired || !record.files || record.files.length === 0) {
    fail(job, 'notfound', 'This file is no longer available to move');
    return;
  }

  job.status = 'uploading';
  emit(job);

  try {
    // Move every non-metadata file (today one media file, but future-proofed
    // for subtitles/thumbnails). Aggregate progress is weighted by byte size.
    const files = record.files
      .map((name) => ({ name, filePath: getDownloadFilePath(job.downloadId, name) }))
      .filter((f) => f.filePath);
    // The files can vanish between the getDownload check above and here if the
    // cleanup scheduler expires the download in that window. Bail instead of
    // falling through to deleteDownload + "complete" with nothing uploaded.
    if (files.length === 0) {
      fail(job, 'notfound', 'This file is no longer available to move');
      return;
    }
    const sizes = files.map((f) => fs.statSync(f.filePath).size);
    const total = sizes.reduce((a, b) => a + b, 0) || 1;

    let uploadedBefore = 0;
    let last = null;

    for (let i = 0; i < files.length; i++) {
      last = await provider.upload({
        accessToken: job.accessToken,
        filePath: files[i].filePath,
        fileName: files[i].name,
        size: sizes[i],
        signal: job.controller.signal,
        onProgress: (pct) => {
          job.progress = Math.min(100, ((uploadedBefore + (pct / 100) * sizes[i]) / total) * 100);
          emit(job);
        },
      });
      uploadedBefore += sizes[i];
    }

    // Confirmed upload → drop the local media but KEEP the metadata row (with
    // its source URL + cloud link) so the download stays re-downloadable from
    // source and openable in the visitor's cloud, on any device.
    const result = { provider: provider.name, ...last };
    markMoved(job.downloadId, result);
    // Mirror it into the per-user history row: a moved download keeps its card
    // (source URL + cloud link) but stops counting toward the owner's quota,
    // since its bytes now live in the visitor's cloud, not ours. Best-effort —
    // the upload itself already succeeded, so a DB blip must not fail the job.
    if (job.store) {
      try {
        await job.store.markMoved(job.downloadId, result);
      } catch (err) {
        console.error(`⚠️  Could not flag ${job.downloadId} as moved: ${err.message}`);
      }
    }

    job.status = 'complete';
    job.progress = 100;
    job.result = result;
    emit(job);
  } catch (err) {
    // Local file is intentionally kept on any failure so the visitor can retry
    // or fall back to downloading it to their device.
    fail(job, err?.code || 'upload', err?.message || 'Upload failed');
  }
}

function drain() {
  while (active < MAX_CONCURRENT && queue.length > 0) {
    const job = queue.shift();
    if (job.status !== 'queued') continue; // dropped while waiting
    active++;
    run(job)
      .catch(() => {})
      .finally(() => {
        active--;
        settle(job);
        drain();
      });
  }
}

// Create a queued upload job and return its snapshot. `accessToken` is held in
// memory on the job only, never logged or persisted. `store` is the per-user
// history store the caller already holds; omitted (unit tests, no database) the
// job just skips the "moved" mirror.
function createJob({ downloadId, providerName, accessToken, store = null }) {
  const jobId = uuidv4();
  const job = {
    jobId,
    downloadId,
    providerName,
    accessToken,
    store,
    status: 'queued',
    progress: 0,
    error: null,
    result: null,
    emitter: new EventEmitter(),
    controller: new AbortController(),
  };
  job.emitter.setMaxListeners(0);
  job.hardTtl = setTimeout(() => {
    job.controller.abort();
    if (job.status === 'queued' || job.status === 'uploading') {
      fail(job, 'timeout', 'Upload timed out');
    }
    settle(job);
  }, JOB_HARD_TTL_MS);

  jobs.set(jobId, job);
  queue.push(job);
  drain();
  return snapshot(job);
}

function getSnapshot(jobId) {
  const job = jobs.get(jobId);
  return job ? snapshot(job) : null;
}

// Subscribe to job updates. Returns an unsubscribe fn, or null if unknown job.
function subscribe(jobId, listener) {
  const job = jobs.get(jobId);
  if (!job) return null;
  job.emitter.on('update', listener);
  return () => job.emitter.off('update', listener);
}

function isTerminal(status) {
  return status === 'complete' || status === 'error';
}

module.exports = { createJob, getSnapshot, subscribe, isTerminal };
