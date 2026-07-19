---
name: setup-auto-claude-pr-review
description: Configure the current GitHub repo for automated Claude PR review by adding the reusable central-agent review workflow and setting its CLAUDE_CODE_OAUTH_TOKEN secret. Use when the user wants to set up, enable, or bootstrap automatic Claude or thermos PR review in a repository, or runs setup-auto-claude-pr-review.
---

# Set up automated Claude PR review

Adds the reusable `iheidari/central-agent` PR-review workflow to the current
repository and sets the `CLAUDE_CODE_OAUTH_TOKEN` secret so it can run.

## Quick start

From the root of the target repository, run the setup script:

```sh
bash "$CLAUDE_SKILL_DIR/scripts/setup.sh"
```

(If `$CLAUDE_SKILL_DIR` isn't set, use the script's absolute path inside this
skill's `scripts/` folder.) Then report the outcome based on its exit code.

## What the script does

1. **Aborts if already configured.** Checks for
   `.github/workflows/claude-pr-review.yml` and greps `.github/workflows/` for an
   existing `uses:` reference to the central-agent review workflow. If either is
   found it prints `ABORT:` and exits **2** without changing anything.
2. **Creates the caller workflow** at `.github/workflows/claude-pr-review.yml`
   from the template below.
3. **Sets the repo secret** by running `secret-get CLAUDE_CODE_OAUTH_TOKEN` and
   piping it into `gh secret set CLAUDE_CODE_OAUTH_TOKEN --repo <owner/repo>`.

## Interpreting the result

- **Exit 0** — created the workflow and set the secret. Tell the user it's live
  and will run on the next PR; remind them to commit & push the new workflow file.
- **Exit 2** — already set up; nothing changed. Report that and stop.
- **Exit 1** — a precondition failed. Surface the `ERROR:` line and help fix it
  (common causes: `gh` not installed/authenticated, not inside a GitHub repo,
  `secret-get` unavailable, or an empty token).

## The workflow template

```yaml
name: PR Review

on:
  pull_request:
    types: [opened, synchronize, reopened]

jobs:
  review:
    uses: iheidari/central-agent/.github/workflows/claude-review.yml@main
    secrets:
      CLAUDE_CODE_OAUTH_TOKEN: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}
```

## Notes

- The script only writes the secret to the repo; the workflow file still needs to
  be **committed and pushed** to take effect. Offer to do that after a successful run.
- Per spec, if the workflow is already present the script does **not** touch the
  secret — it aborts entirely. If the user needs to (re)set just the secret on an
  already-configured repo, run `secret-get CLAUDE_CODE_OAUTH_TOKEN | gh secret set CLAUDE_CODE_OAUTH_TOKEN` directly.
