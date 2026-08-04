// Guards the repo-root manifest against runtime dependencies (0XC-333).
//
// This lives in the BACKEND suite rather than somewhere neutral because the
// backend is what the hazard threatens. Node resolves a bare specifier by
// walking UP from the requiring file, so a package declared at the repo root
// is invisible right up until it isn't: while `backend/node_modules` is intact
// the root copy shadows nothing, and the moment it isn't — a partial install,
// an `--omit` flag, a slimmer image layer, `node backend/src/server.js` run
// against a root-only install — the walk continues past the backend and the
// root copy silently SUBSTITUTES itself.
//
// That is not hypothetical drift. The five entries this test exists to keep
// out (`express`, `helmet`, `uuid`, `cors`, `morgan`) were residue from before
// the backend package split, and they had drifted a whole major ahead of the
// backend's pins — root `express@^5.2.1` against backend `express@^4.18.2`.
// So the substitution would have handed the backend a breaking-change major
// with no error raised anywhere near the point of failure. With the root
// manifest clean the same scenario fails loudly with MODULE_NOT_FOUND.
//
// Three claims are pinned, and the third is the one that catches a half-done
// fix: the manifest is clean, the LOCKFILE agrees with it (an entry deleted
// from `package.json` without regenerating `package-lock.json` still installs
// on `npm ci`, which reads the lock), and the backend genuinely owns a copy of
// everything it declares rather than having been leaning on the root all along.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..', '..');
const backendDir = path.resolve(__dirname, '..');

const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));

test('the root package.json declares no runtime dependencies', () => {
  const rootPkg = readJson(path.join(repoRoot, 'package.json'));
  const declared = Object.keys(rootPkg.dependencies ?? {});

  assert.deepStrictEqual(
    declared,
    [],
    `the repo-root package.json must stay a tooling host (Biome + nodemon) and declare no ` +
      `runtime dependencies, but it declares: ${declared.join(', ')}. A root runtime dep ` +
      `shadows the backend's own copy — see CLAUDE.md. If one is genuinely needed at the ` +
      `root, document its consumer there and pin it to the same major as backend/.`,
  );
});

test('the root package-lock.json agrees — npm ci installs no runtime deps either', () => {
  const rootLock = readJson(path.join(repoRoot, 'package-lock.json'));
  // The "" key is the lockfile's entry for the root project itself.
  const declared = Object.keys(rootLock.packages?.['']?.dependencies ?? {});

  assert.deepStrictEqual(
    declared,
    [],
    `package-lock.json still records root runtime dependencies (${declared.join(', ')}). ` +
      `npm ci installs from the LOCK, not from package.json, so deleting an entry from the ` +
      `manifest without regenerating the lock changes nothing about what gets installed.`,
  );
});

test('the backend owns a copy of every runtime dependency it declares', () => {
  const backendPkg = readJson(path.join(backendDir, 'package.json'));
  const deps = Object.keys(backendPkg.dependencies ?? {});

  // Non-vacuity: a walk over an empty list would pass forever.
  assert.ok(deps.length > 0, 'expected backend/package.json to declare runtime dependencies');

  const missing = deps.filter((dep) => !fs.existsSync(path.join(backendDir, 'node_modules', dep)));

  assert.deepStrictEqual(
    missing,
    [],
    `these backend dependencies have no copy under backend/node_modules: ${missing.join(', ')}. ` +
      `They would resolve from somewhere further up the tree instead — exactly the shadowing ` +
      `this file guards against. Run \`cd backend && npm ci\`.`,
  );
});
