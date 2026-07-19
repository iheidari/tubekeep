---
name: ship
description: Fast path to ship the current branch — verify (format + typecheck + lint, all scoped to changed files), then commit, push, and open a PR after one confirmation. Leaner than create-pr (no simplify/thermos menu). Use when the user types /ship or asks to quickly verify-and-PR the current work.
disable-model-invocation: true
---

# Ship

The fast lane from "code is written" to "PR is open": verify, then commit, push, and open a
PR after a **single** confirmation. No interactive pre-flight menu, no simplify or thermos
passes — for that careful path, use `/create-pr` instead.

Requires the `gh` CLI.

## Which to use

- **/ship** — you trust the change; just verify and open the PR. One confirmation.
- **/create-pr** — bigger or riskier; you want a simplify pass and thermos review first.

## Workflow

### 1. Verify (every gate must pass)

Run in this order. **Format and lint touch only changed files** so a repo's pre-existing
lint debt never blocks new work, and a repo-wide reformat never balloons the diff:

1. **Format changed files:** `pnpm exec biome format --write --changed --since=main`, then
   re-stage anything it rewrites. Never run repo-wide `pnpm format`.
2. **Typecheck (hard gate):** `pnpm -s typecheck` — must exit clean.
3. **Lint changed files:** `pnpm exec biome check --changed --since=main` — must pass.
4. **Tests:** run the repo's test command **only if a `test` script exists**. If none, report
   "no tests found" and skip — never fabricate a test command.

> Detect commands from the repo's `package.json`; the commands above are the milemark-admin
> defaults (pnpm + Biome 1.9, no test script).

If any gate fails: **stop and report** with file/line detail. Do not commit, do not open a
PR. The user can re-run `/ship` once it's fixed. (Never commit or push without the explicit
go-ahead that invoking `/ship` represents.)

### 2. Confirm once, then ship

Only after every gate passes:

1. If on the default branch (`main`/`master`), create a feature branch first — the pre-push
   hook blocks direct pushes to `main`.
2. Stage changes; draft a concise commit message and a PR title + body from the diff.
3. Show the target branch, commit message, and PR title/body, and ask for **one** confirmation.
4. On approval only: commit, `git push -u`, and open the PR with `gh pr create`.

End the commit message with:

```
Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
```

End the PR body with:

```
🤖 Generated with [Claude Code](https://claude.com/claude-code)
```

Report the PR URL when done.
