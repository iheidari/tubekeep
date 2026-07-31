// Preloaded into every test process by `npm test` (see package.json).
//
// Node's test runner uses the test process's **stdout** to send v8-serialized
// result frames back to the runner. Application `console.log` output goes to the
// same stream, and the two are separate write() calls into one pipe — so a log
// line emitted mid-frame splits it, and the runner fails to deserialize what it
// reads back:
//
//   Error: Unable to deserialize cloned data due to invalid or unsupported version.
//       at #processRawBuffer (node:internal/test_runner/runner:422:20)
//
// It surfaces as a whole test FILE failing at its boundary while every test in
// it passed, which reads like an infrastructure blip rather than a real failure.
// The rate scales with how much the code under test logs: routes/download.test.js
// (whose route logs on nearly every path) hit it roughly 1 run in 100, and a
// file logging ~600 lines reproduces it 30 times out of 30.
//
// The fix is to keep application output off the child's stdout. It's REDIRECTED
// to stderr rather than dropped, so the logs are still there when you're
// debugging a test: the runner captures the child's stderr and re-emits it as a
// framed diagnostic event, so the text still shows up in the test output — it
// just no longer races the stream carrying the result frames. Test results,
// reporter output and assertion diffs are unaffected: the runner writes those
// itself rather than going through console.
//
// Verified rather than assumed, since the mechanism is internal to Node: the
// stress case (a test file emitting ~600 log lines) fails 30 runs out of 30
// without this file and 0 out of 60 with it, and `--require` is confirmed to
// run in each spawned test child, not just the parent runner process.
const { Console } = require('node:console');

// Covers every console method (log/error/warn/info/debug/table/dir/trace/…) in
// one assignment, rather than stubbing them one at a time and missing the next
// one a route reaches for.
global.console = new Console({ stdout: process.stderr, stderr: process.stderr });
