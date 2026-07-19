---
name: git-cleanup
description: List local git branches whose GitHub PR has been merged, then delete them (and their remote branch) after user confirmation. Use when the user wants to clean up, prune, or remove stale or merged local branches, tidy up branches after PRs merge, or mentions "git cleanup", "delete merged branches", or "clean local branches".
---

# git-cleanup

Removes local branches whose pull request is already merged on GitHub, plus their remote
branch when one still exists. Always confirms with the user before deleting anything.
Never touches the current branch or the default branch — both are excluded by the detector.

## Quick start

```bash
bash scripts/find-merged-branches.sh   # detect merged branches; deletes nothing
```

## Workflow

1. **Detect** — run the detector from this skill's directory:
   ```bash
   bash scripts/find-merged-branches.sh
   ```
   It runs `git fetch --prune`, then prints one tab-separated line per merged branch:
   `branch<TAB>PR#<TAB>title<TAB>remote`. The `remote` column is the remote name (e.g.
   `origin`) if a remote branch still exists, or empty if it was already deleted on
   GitHub (common after merge with auto-delete). Preflight errors (not a git repo, `gh`
   missing or unauthenticated) go to stderr with a non-zero exit — surface the message
   and stop.

2. **Handle empty result** — if there is no output, tell the user there are no merged
   branches to clean up, and stop.

3. **Present** — show a numbered list, one branch per line as `branch — PR #<n> — <title>`.
   Mark which branches also have a live remote (those will be deleted remotely too).
   Make clear every listed branch has a merged PR.

4. **Confirm** — every branch is selected by default; ask the user to confirm deleting
   all, or to narrow to a subset (by number or name), or cancel. Never delete without
   explicit confirmation.

5. **Delete** — for each confirmed branch:
   ```bash
   git branch -D <branch>                  # local; always
   git push <remote> --delete <branch>     # remote; only if the remote column is non-empty
   ```
   Force delete (`-D`) is required: squash and rebase merges leave the local branch
   looking unmerged to git, so `-d` would fail on exactly these branches. The merged PR
   was already verified by the detector, so `-D` is safe here. Skip the remote push when
   the remote column is empty — the remote branch is already gone.

6. **Report** — list what was deleted (local and remote) and anything skipped.

## Notes

- Merge status comes only from GitHub via `gh`. A branch with no merged PR — or no PR at
  all — is never listed, so unmerged work is safe.
- Idempotent: re-run anytime. The current and default branches are always protected.
