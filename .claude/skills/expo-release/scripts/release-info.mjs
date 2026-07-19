#!/usr/bin/env node
// Read-only release discovery. Prints JSON the skill uses to recommend a
// version and curate notes. Never writes anything.
//
//   node release-info.mjs
//
// Env overrides (defaults target this monorepo):
//   RELEASE_APP_DIR     app folder holding package.json/app.config.ts (default: apps/mobile, else ".")
//   RELEASE_TAG_PREFIX  release tag prefix (default: "mobile-v")
import { readFileSync, existsSync } from 'node:fs';
import { execSync } from 'node:child_process';

const APP_DIR = process.env.RELEASE_APP_DIR || (existsSync('apps/mobile') ? 'apps/mobile' : '.');
const TAG_PREFIX = process.env.RELEASE_TAG_PREFIX || 'mobile-v';

const sh = (cmd) => {
  try { return execSync(cmd, { encoding: 'utf8' }).trim(); } catch { return ''; }
};

const pkg = JSON.parse(readFileSync(`${APP_DIR}/package.json`, 'utf8'));
const current = pkg.version;

const tags = sh(`git tag --list "${TAG_PREFIX}*" --sort=-v:refname`).split('\n').filter(Boolean);
const lastTag = tags[0] || null;

// Commits since the last release that touched the app or the shared package it
// depends on. No tag yet => whole history (first release).
const range = lastTag ? `${lastTag}..HEAD ` : '';
const subjects = sh(`git log --no-merges --pretty=%s ${range}-- ${APP_DIR} packages/shared`)
  .split('\n').filter(Boolean);

// Infer the SemVer bump from Conventional-Commit subjects.
let bump = subjects.length ? 'patch' : 'patch';
for (const s of subjects) {
  if (/^[a-z]+(\([^)]*\))?!:/.test(s) || /BREAKING[ _-]?CHANGE/.test(s)) { bump = 'major'; break; }
  if (/^feat(\([^)]*\))?:/.test(s)) bump = 'minor';
}

const m = current.match(/^(\d+)\.(\d+)\.(\d+)$/);
let suggested = null;
if (m) {
  const [maj, min, pat] = [Number(m[1]), Number(m[2]), Number(m[3])];
  suggested = bump === 'major' ? `${maj + 1}.0.0`
    : bump === 'minor' ? `${maj}.${min + 1}.0`
    : `${maj}.${min}.${pat + 1}`;
}

const today = new Date().toISOString().slice(0, 10);

console.log(JSON.stringify({
  appDir: APP_DIR,
  tagPrefix: TAG_PREFIX,
  current,
  lastTag,
  suggestedBump: bump,
  suggested,
  today,
  commitCount: subjects.length,
  commits: subjects,
}, null, 2));
