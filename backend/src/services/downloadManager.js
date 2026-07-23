const { EventEmitter } = require('node:events');
const { downloadVideo, downloadAudio } = require('./ytdlp');
const { saveDownloadMetadata } = require('../utils/storage');
const { friendlyYtDlpError } = require('../utils/friendlyError');

// In-memory registry of download jobs, keyed by downloadId. A job runs yt-dlp to
// completion INDEPENDENT of any client SSE connection, so navigating away from
// the download page no longer aborts it. Observers attach via subscribe() — the
// job's `emitter` stays internal to this module. In-memory only: an in-flight
// download dies on server restart, and a reconnect to an unknown id gets a clear
// "download not found" (see 0XC-26 "out of scope").
const jobs = new Map();

// Max simultaneously-RUNNING jobs per process. Read per-call so the env var can
// change without a code edit; any unset/invalid value falls back to 3.
function maxConcurrent() {
  const n = Number.parseInt(process.env.MAX_CONCURRENT_DOWNLOADS, 10);
  return Number.isInteger(n) && n > 0 ? n : 3;
}

// How long a terminal (complete/error) job record is retained so a late
// reconnect can still replay its outcome, before the cleanup sweep prunes it.
const TERMINAL_TTL_MS = 30 * 60 * 1000;

// Thrown by startJob when the concurrency cap is hit. The route maps this to a
// 429 so the UI can surface a distinct "server busy" message.
class DownloadCapError extends Error {
  constructor(limit) {
    super(`Server busy — too many downloads running (max ${limit}), try again shortly.`);
    this.name = 'DownloadCapError';
    this.code = 'CAP_EXCEEDED';
  }
}

function runningCount() {
  let n = 0;
  for (const job of jobs.values()) {
    if (job.status === 'running') n++;
  }
  return n;
}

// Attach an observer to a job. Synchronously replays the job's current state
// (its terminal outcome, or the latest progress) to the matching callback, then
// — only while it's still running — subscribes to future events. Returns an
// unsubscribe function, or `null` if no job exists for the id. Keeping the
// replay + subscribe atomic *here* (never yielding between them) is what
// guarantees a terminal event can't slip through the gap; callers must not
// reach into `job.emitter` and re-implement it.
function subscribe(downloadId, { onProgress, onComplete, onError }) {
  const job = jobs.get(downloadId);
  if (!job) return null;

  if (job.status === 'complete') {
    onComplete(job.result);
    return () => {};
  }
  if (job.status === 'error') {
    onError(job.error);
    return () => {};
  }

  onProgress(job.progress);
  job.emitter.on('progress', onProgress);
  job.emitter.on('complete', onComplete);
  job.emitter.on('error', onError);
  return () => {
    job.emitter.off('progress', onProgress);
    job.emitter.off('complete', onComplete);
    job.emitter.off('error', onError);
  };
}

// Run a caller-supplied terminal hook (see startJob) without letting it affect
// the job: the hooks persist the outcome to Postgres, and a database blip must
// not turn a finished download into a failed one — or crash the process on an
// unhandled rejection.
async function runHook(hook, arg, downloadId) {
  if (typeof hook !== 'function') return;
  try {
    await hook(arg);
  } catch (err) {
    console.error(`❌ Download job hook failed ${downloadId}: ${err.message}`);
  }
}

// Drive one job's yt-dlp download to completion, relaying progress and the
// terminal outcome through its emitter. Never throws — the terminal state is
// captured on the job record so observers (current and future) can read it.
async function runJob(job) {
  const { downloadId, url, formatId, type, title, thumbnail, keep, captions } = job.params;
  const { signal } = job.abortController;

  const onProgress = (p) => {
    job.progress = Math.min(100, Math.max(0, p));
    job.emitter.emit('progress', job.progress);
  };

  try {
    let result;
    if (type === 'audio') {
      result = await downloadAudio(url, formatId, downloadId, onProgress, signal);
    } else if (type === 'video') {
      // Video-only format — merged with best audio.
      result = await downloadVideo(url, formatId, downloadId, onProgress, true, signal);
    } else {
      // Combined (pre-merged) format.
      result = await downloadVideo(url, formatId, downloadId, onProgress, false, signal);
    }

    // `type` and `keep` are already normalized by the route before startJob, so
    // no re-defaulting/coercion is needed here.
    const metadata = {
      url,
      title: title || result.filename,
      thumbnail,
      formatId,
      type,
      filename: result.filename,
      size: result.size,
      kept: keep,
      createdAt: new Date().toISOString(),
      downloadId,
    };
    // Caption availability, split by manual/auto (0XC-14). Omitted entirely
    // (rather than defaulted to empty arrays) when the route didn't supply it,
    // so "no captions" stays distinguishable from "unknown" in metadata.json.
    if (captions) {
      metadata.captions = captions;
    }
    saveDownloadMetadata(downloadId, metadata);

    job.status = 'complete';
    job.progress = 100;
    job.result = {
      ...metadata,
      fileUrl: `/api/files/${downloadId}/${encodeURIComponent(result.filename)}`,
    };
    job.terminalAt = Date.now();
    console.log(`✅ Download job complete ${downloadId}`);
    // Persist the outcome (the DB row's real filename + size) BEFORE telling
    // observers, so a client that reloads the moment it sees `complete` reads a
    // history row that already matches.
    await runHook(job.hooks.onComplete, job.result, downloadId);
    job.emitter.emit('complete', job.result);
  } catch (error) {
    // downloadVideo/downloadAudio already deleteDownload() their partial files on
    // any failure — including our cancel-abort — so there's nothing to clean up
    // here beyond recording the terminal state.
    job.status = 'error';
    // Surface friendly copy to the client (SSE `error`) while keeping the full
    // raw stderr in the server log below for operators (see 0XC-95).
    job.error = job.cancelled ? 'Download cancelled' : friendlyYtDlpError(error.message);
    job.terminalAt = Date.now();
    if (job.cancelled) {
      console.log(`🛑 Download job cancelled ${downloadId}`);
    } else {
      console.error(`❌ Download job error ${downloadId}:`, error.message);
    }
    await runHook(job.hooks.onError, job.error, downloadId);
    job.emitter.emit('error', job.error);
  }
}

// Mint a running job and kick off its download. Enforces the concurrency cap —
// the single place it's checked, before any SSE is opened. Returns the job.
//
// `hooks` ({ onComplete(result), onError(message) }) let the caller persist the
// terminal outcome — the download route wires them to the per-user `downloads`
// row. They're injected rather than imported so this module stays free of any
// database dependency (and unit-testable without one); failures inside them are
// swallowed and logged (see runHook).
function startJob(params, hooks = {}) {
  if (runningCount() >= maxConcurrent()) {
    throw new DownloadCapError(maxConcurrent());
  }

  const emitter = new EventEmitter();
  // A Node EventEmitter throws if an 'error' event is emitted with no listener.
  // Keep a permanent no-op so a terminal error with no observer attached (the
  // common keep-running-in-background case) can't crash the process.
  emitter.on('error', () => {});

  const job = {
    downloadId: params.downloadId,
    status: 'running',
    progress: 0,
    result: null,
    error: null,
    cancelled: false,
    terminalAt: null,
    params,
    hooks,
    emitter,
    abortController: new AbortController(),
  };

  jobs.set(job.downloadId, job);
  console.log(
    `🚀 Download job started ${job.downloadId} (${runningCount()}/${maxConcurrent()} running)`,
  );
  // Fire-and-forget: runJob owns the job's lifetime and never throws.
  runJob(job);
  return job;
}

// Cancel a running job: abort the yt-dlp subprocess (its own cleanup removes the
// partial files) and drop the record so the slot frees up. Returns false if no
// job exists for the id. A completed job's finished file is never touched.
function cancelJob(downloadId) {
  const job = jobs.get(downloadId);
  if (!job) return false;
  if (job.status === 'running') {
    job.cancelled = true;
    job.abortController.abort();
    console.log(`⚠️  Cancelling download ${downloadId}`);
  }
  jobs.delete(downloadId);
  return true;
}

// Prune terminal job records older than the retention window. Called by the
// hourly cleanup scheduler so long-lived processes don't accumulate them.
function sweepJobs(now = Date.now()) {
  let pruned = 0;
  for (const [id, job] of jobs) {
    if (job.status !== 'running' && job.terminalAt && now - job.terminalAt > TERMINAL_TTL_MS) {
      jobs.delete(id);
      pruned++;
    }
  }
  return pruned;
}

module.exports = {
  startJob,
  subscribe,
  cancelJob,
  sweepJobs,
  DownloadCapError,
};
