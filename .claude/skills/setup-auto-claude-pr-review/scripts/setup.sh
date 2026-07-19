#!/usr/bin/env bash
# Idempotently configure a GitHub repo for automated Claude PR review:
#   1. Abort if the workflow is already present (by filename or by reference).
#   2. Otherwise create the caller workflow from the template.
#   3. Set the CLAUDE_CODE_OAUTH_TOKEN repo secret via `secret-get` + `gh`.
#
# Exit codes: 0 = configured, 2 = aborted (already set up), 1 = error.
set -euo pipefail

WORKFLOW_DIR=".github/workflows"
WORKFLOW_FILE="$WORKFLOW_DIR/claude-pr-review.yml"
REF_MATCH="iheidari/central-agent/.github/workflows/claude-review.yml"
SECRET_NAME="CLAUDE_CODE_OAUTH_TOKEN"

# 0. Preconditions ----------------------------------------------------------
command -v gh >/dev/null 2>&1 || { echo "ERROR: gh CLI not found (https://cli.github.com)"; exit 1; }
gh auth status >/dev/null 2>&1 || { echo "ERROR: gh not authenticated — run: gh auth login"; exit 1; }
command -v secret-get >/dev/null 2>&1 || { echo "ERROR: secret-get command not found"; exit 1; }
REPO=$(gh repo view --json nameWithOwner -q .nameWithOwner 2>/dev/null) \
  || { echo "ERROR: not inside a GitHub repo with a remote"; exit 1; }

# 1. Abort if already configured -------------------------------------------
if [ -f "$WORKFLOW_FILE" ]; then
  echo "ABORT: $WORKFLOW_FILE already exists — nothing to do."
  exit 2
fi
if [ -d "$WORKFLOW_DIR" ] && grep -rql "$REF_MATCH" "$WORKFLOW_DIR" 2>/dev/null; then
  echo "ABORT: a workflow in $WORKFLOW_DIR already references the central-agent review workflow — nothing to do."
  exit 2
fi

# 2. Create the caller workflow --------------------------------------------
mkdir -p "$WORKFLOW_DIR"
cat > "$WORKFLOW_FILE" <<'YAML'
name: PR Review

on:
  pull_request:
    types: [opened, synchronize, reopened]

jobs:
  review:
    uses: iheidari/central-agent/.github/workflows/claude-review.yml@main
    secrets:
      CLAUDE_CODE_OAUTH_TOKEN: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}
YAML
echo "CREATED: $WORKFLOW_FILE"

# 3. Set the repo secret ----------------------------------------------------
# Capture via command substitution (strips trailing newline); keep it out of argv.
TOKEN=$(secret-get "$SECRET_NAME") || { echo "ERROR: secret-get $SECRET_NAME failed"; exit 1; }
[ -n "$TOKEN" ] || { echo "ERROR: secret-get returned an empty value for $SECRET_NAME"; exit 1; }
printf '%s' "$TOKEN" | gh secret set "$SECRET_NAME" --repo "$REPO" \
  || { echo "ERROR: failed to set $SECRET_NAME on $REPO"; exit 1; }
echo "SECRET SET: $SECRET_NAME on $REPO"

echo "DONE: automated Claude PR review configured for $REPO"
