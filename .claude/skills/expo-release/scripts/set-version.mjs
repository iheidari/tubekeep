#!/usr/bin/env node
// Write a SemVer version into package.json + app.config.ts (the dynamic Expo
// config keeps the version as a `version: "x.y.z"` string literal). Mirrors the
// patch logic the old build.sh used. Does NOT touch git or run EAS.
//
//   node set-version.mjs 2.1.0
//
// Env: RELEASE_APP_DIR (default: apps/mobile, else ".")
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const version = process.argv[2];
const APP_DIR = process.env.RELEASE_APP_DIR || (existsSync('apps/mobile') ? 'apps/mobile' : '.');

if (!/^\d+\.\d+\.\d+$/.test(version || '')) {
  console.error(`Usage: set-version.mjs <MAJOR.MINOR.PATCH>  (got: "${version ?? ''}")`);
  process.exit(1);
}

const pkgPath = `${APP_DIR}/package.json`;
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
const prev = pkg.version;
pkg.version = version;
writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');

const touched = [pkgPath];
const appPath = `${APP_DIR}/app.config.ts`;
if (existsSync(appPath)) {
  const app = readFileSync(appPath, 'utf8');
  const re = /(\n\s*version:\s*)(["'])\d+\.\d+\.\d+\2/;
  if (!re.test(app)) {
    console.error(`Error: no 'version: "x.y.z"' line found in ${appPath}`);
    process.exit(1);
  }
  writeFileSync(appPath, app.replace(re, `$1"${version}"`));
  touched.push(appPath);
}

console.log(`${prev} -> ${version}  (${touched.join(', ')})`);
