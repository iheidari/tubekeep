#!/usr/bin/env bash
#
# find-merged-branches.sh
#
# Lists local branches whose pull request is MERGED on GitHub.
# Output: one tab-separated line per merged branch:
#   <branch>\t<pr#>\t<title>\t<remote>
# The <remote> column is the remote name (e.g. "origin") if the remote branch
# still exists, or empty if it was already deleted on GitHub (common after a
# merge with auto-delete). Deletes nothing. The current and default branches
# are never listed.
#
set -euo pipefail

# --- Preflight ---------------------------------------------------------------
if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "ERROR: not inside a git repository" >&2
  exit 1
fi
if ! command -v gh >/dev/null 2>&1; then
  echo "ERROR: GitHub CLI (gh) is not installed — see https://cli.github.com" >&2
  exit 1
fi
if ! gh auth status >/dev/null 2>&1; then
  echo "ERROR: gh is not authenticated — run: gh auth login" >&2
  exit 1
fi

# --- Refresh remote state ----------------------------------------------------
# Drops remote-tracking refs for branches deleted on GitHub so merge status and
# remote existence are accurate.
git fetch --prune --quiet 2>/dev/null || true

# --- Resolve protected branches and default remote ---------------------------
current="$(git rev-parse --abbrev-ref HEAD)"
default="$(gh repo view --json defaultBranchRef --jq '.defaultBranchRef.name' 2>/dev/null || true)"
[ -z "$default" ] && default="main"

default_remote="origin"
if ! git remote | grep -qx "origin"; then
  default_remote="$(git remote | head -n1 || true)"
fi

# --- Scan local branches -----------------------------------------------------
while IFS= read -r branch; do
  [ -z "$branch" ] && continue
  [ "$branch" = "$current" ] && continue
  [ "$branch" = "$default" ] && continue

  # Emit "<pr#>\t<title>" only if a MERGED PR has this branch as its head.
  info="$(gh pr list --head "$branch" --state merged --limit 1 \
            --json number,title \
            --jq '.[0] | select(.) | "\(.number)\t\(.title)"' 2>/dev/null || true)"
  [ -z "$info" ] && continue

  # Does a live remote branch still exist? (Often deleted on merge.)
  remote="$(git config "branch.$branch.remote" 2>/dev/null || true)"
  [ -z "$remote" ] && remote="$default_remote"
  remote_col=""
  if [ -n "$remote" ] && git show-ref --verify --quiet "refs/remotes/$remote/$branch"; then
    remote_col="$remote"
  fi

  printf '%s\t%s\t%s\n' "$branch" "$info" "$remote_col"
done < <(git for-each-ref --format='%(refname:short)' refs/heads/)
