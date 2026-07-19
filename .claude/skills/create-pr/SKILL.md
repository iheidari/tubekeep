---
name: create-pr
description: Run the pre-PR pipeline — simplify, test/lint/format, thermos review — then commit, push, and open a pull request automatically once the checks pass. Always runs all three steps unless the user names one to skip. Use when the user types /create-pr or asks to create/open a PR with pre-flight checks.
disable-model-invocation: true
---

# Create PR

Prepare the current branch and open a pull request. **Always run all three pre-flight
steps** — simplify, test/lint/format, and thermos review — in a fixed order, then create
the PR automatically once they pass. Do **not** ask which steps to run; invoking the skill
is itself the request to run the full pipeline and create the PR.

The only time a step is skipped is when the user explicitly names it when invoking the
skill (e.g. "/create-pr skip thermos", "without simplify", "no tests"). In that case, skip
exactly the named step(s) silently and run the rest. Absent such an instruction, run all
three.

Requires the `gh` CLI for the final PR step.

## Workflow

Run steps 2 → 3 → 4 in order, then step 5. Skip a step only if the user named it when
invoking the skill (see above).

### 2. Simplify

Invoke the `simplify` skill via the Skill tool and let it apply its changes to the working tree.

### 3. Test / lint / format

Detect commands from the repo's `package.json` scripts (or the framework's defaults).
Run formatter **first** (it may rewrite files), then lint, typecheck, then tests.
For this monorepo (pnpm + Biome) the commands are:

- Format: `pnpm format`
- Lint: `pnpm lint`
- Typecheck: `pnpm typecheck`
- Test: run `pnpm test` (or `pnpm -r test`) **only if a `test` script exists**. If none exists, report "no tests found" and skip — never fabricate a test command.

### 4. Thermos review

Invoke the `thermos` skill via the Skill tool, scoped to the current branch's diff.
Read its synthesized verdict and surface the highest-signal findings.

### Failure handling

If any check fails, or thermos reports a blocker: **pause and report** with file/line detail.
Do NOT auto-fix and do NOT create the PR. Let the user decide; they can re-run `/create-pr`
once it's addressed.

### 5. Create the PR

Only after every step that ran passes — proceed without asking for confirmation:

1. If on the default branch (`main`/`master`), create a feature branch first.
2. Stage changes; draft a commit message and a concise PR title + body summarizing the diff.
3. Commit, push with `-u`, and open the PR with `gh pr create`.

The only thing that stops PR creation is a failed check or a thermos blocker (see
**Failure handling**) — a passing pipeline goes straight to the PR.

End the commit message with:

```
Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
```

End the PR body with:

```
🤖 Generated with [Claude Code](https://claude.com/claude-code)
```

Report the PR URL when done.
