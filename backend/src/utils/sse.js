// Shared Server-Sent-Events setup for the streaming routes (download progress,
// cloud-upload progress). Sets the standard SSE/keep-alive headers (incl.
// X-Accel-Buffering so nginx/proxies don't buffer the stream) and returns a
// `send` fn that JSON-encodes each event and flushes it, no-op once the socket
// has closed. Heartbeats stay per-route since their payloads differ.
function initSSE(res) {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // Disable nginx/proxy buffering
  res.flushHeaders();

  return (data) => {
    if (res.writableEnded) return;
    res.write(`data: ${JSON.stringify(data)}\n\n`);
    if (typeof res.flush === 'function') res.flush();
  };
}

module.exports = { initSSE };
