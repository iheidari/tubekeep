const express = require('express');
const router = express.Router();
const { getProvider, listEnabledProviders } = require('../services/cloud');
const { createJob, getSnapshot, subscribe, isTerminal } = require('../services/cloud/jobs');
const { isValidDownloadId } = require('../utils/storage');
const { initSSE } = require('../utils/sse');

// Which cloud providers are configured on this server (public config only, no
// secrets). The frontend hides the "Move to cloud" button when this is empty.
router.get('/providers', (_req, res) => {
  res.json({ success: true, data: listEnabledProviders() });
});

// Stateless OAuth relay: authorization-code → tokens. The app secret lives only
// here; tokens are returned to the browser and nothing is persisted.
router.post('/oauth/token', async (req, res) => {
  const { provider: providerName, code, codeVerifier, redirectUri } = req.body || {};
  const provider = getProvider(providerName);
  if (!provider) {
    return res.status(400).json({ success: false, error: 'Unknown or disabled provider' });
  }
  if (!code || !codeVerifier) {
    return res.status(400).json({ success: false, error: 'code and codeVerifier are required' });
  }

  try {
    const tokens = await provider.exchangeCode({ code, codeVerifier, redirectUri });
    res.json({ success: true, data: tokens });
  } catch (err) {
    // provider errors are pre-sanitised (no token/code content); safe to return.
    console.error(`❌ OAuth exchange failed (${providerName}): ${err.message}`);
    res.status(502).json({ success: false, error: err.message });
  }
});

// Stateless OAuth relay: refresh-token → fresh access token.
router.post('/oauth/refresh', async (req, res) => {
  const { provider: providerName, refreshToken } = req.body || {};
  const provider = getProvider(providerName);
  if (!provider) {
    return res.status(400).json({ success: false, error: 'Unknown or disabled provider' });
  }
  if (!refreshToken) {
    return res.status(400).json({ success: false, error: 'refreshToken is required' });
  }

  try {
    const tokens = await provider.refresh({ refreshToken });
    res.json({ success: true, data: tokens });
  } catch (err) {
    console.error(`❌ OAuth refresh failed (${providerName}): ${err.message}`);
    res.status(502).json({ success: false, error: err.message });
  }
});

// Start a move. The access token arrives in the body (never a URL) and is held
// in memory on the job only; we return an opaque jobId the SSE stream watches.
router.post('/upload', (req, res) => {
  const { downloadId, provider: providerName, accessToken } = req.body || {};
  if (!getProvider(providerName)) {
    return res.status(400).json({ success: false, error: 'Unknown or disabled provider' });
  }
  if (!isValidDownloadId(downloadId)) {
    return res.status(400).json({ success: false, error: 'A valid downloadId is required' });
  }
  if (typeof accessToken !== 'string' || accessToken.length === 0) {
    return res.status(400).json({ success: false, error: 'accessToken is required' });
  }

  const job = createJob({ downloadId, providerName, accessToken });
  res.json({ success: true, data: { jobId: job.jobId, status: job.status } });
});

// SSE stream of a job's progress. URL carries only the opaque jobId.
router.get('/upload/:jobId/progress', (req, res) => {
  const { jobId } = req.params;
  const initial = getSnapshot(jobId);
  if (!initial) {
    return res.status(404).json({ success: false, error: 'Upload job not found' });
  }

  const send = initSSE(res);

  const heartbeat = setInterval(() => send({ type: 'ping' }), 15000);

  let unsubscribe = null;
  const finish = () => {
    clearInterval(heartbeat);
    if (unsubscribe) unsubscribe();
    if (!res.writableEnded) res.end();
  };

  const onUpdate = (snap) => {
    send({ type: 'progress', ...snap });
    if (isTerminal(snap.status)) finish();
  };

  // Deliver current state immediately, then stream updates. Note: we do NOT
  // abort the upload if the client disconnects — a move is a server→cloud
  // transfer that should survive the tab closing.
  send({ type: 'progress', ...initial });
  if (isTerminal(initial.status)) {
    finish();
    return;
  }
  unsubscribe = subscribe(jobId, onUpdate);
  if (!unsubscribe) {
    finish();
    return;
  }
  req.on('close', finish);
});

module.exports = router;
