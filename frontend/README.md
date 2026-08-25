# Tubekeep — frontend

The Vite + React single-page app. Plain JSX (no TypeScript build), routed with
`react-router-dom`, talking to the Express API in [`../backend`](../backend).

## Scripts

Run from this directory:

| Script | What it does |
| --- | --- |
| `npm run dev` | Vite dev server on port 5173, proxying `/api` to the backend on port 3001 |
| `npm run build` | Production build to `dist/` |
| `npm run lint` | Biome (lint + format diagnostics), using the repo-root `biome.json` |
| `npm run test:unit` | `node --test` over the DOM-free `src/lib` modules (`src/lib/*.test.js`) |
| `npm test` | Playwright accessibility smoke suite (`test/a11y/`) |

There are two suites and they are deliberately separate commands. `test:unit` needs
nothing at all — no browser, no dependencies, no bundler — because the modules it
covers are pure and DOM-free; the `localStorage` doubles it uses live in
`test/helpers/webStorage.js`. `npm test` stays the Playwright suite, which needs a
browser on a fresh clone — run `npm run test:install` once before the first `npm test`.

`npm run preview` serves the built `dist/` on port 4173 with the same API proxy, and
`npm run test:ui` opens the Playwright UI.

## Where the rest is documented

This package deliberately keeps no documentation of its own beyond the above. See:

- [`../README.md`](../README.md) — what Tubekeep is, the architecture, and how to run
  both services together.
- [`../CLAUDE.md`](../CLAUDE.md) — the conventions to read before editing this package,
  under **Frontend (`frontend/src/`)** and **Styling system — non-obvious**. Read the
  latter first; the styling setup is not what the file layout suggests.
