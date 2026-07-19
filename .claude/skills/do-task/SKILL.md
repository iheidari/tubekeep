---
name: do-task
description: Pick up the highest-priority Linear issue labeled "Ready to play" (or a specific issue when given its identifier), move it to In Progress, implement it (in an isolated git worktree only when another task is already in flight — otherwise a local branch), commit, then run focused passes in subagents (docs, test coverage, a11y, SEO/GEO/AEO in parallel; then simplify; then thermos review) committing after each, open a PR, move the issue to In Review, watch its CI to green, then move the issue to Done only after you confirm the PR is merged. Use when the user runs /do-task [ISSUE] or says "do task", "do the next task", or "do ABC-12".
disable-model-invocation: true
---

Execute a **Linear issue** end-to-end: pick → plan → move to **In Progress** →
implement on a branch (or worktree) → commit → **review passes** (docs, test coverage, a11y,
SEO/GEO/AEO — in parallel) → **simplify** → **thermos** review + fix → **full test gate** (unit +
e2e integration) → PR (committing after each pass) → move to **In Review** → **watch CI to green**.
The issue is **not** moved to `Done` until the user confirms the PR merged — at which point you
finalize and clean up. The skill argument is an optional Linear issue identifier (`/do-task
0XC-12`) or empty (`/do-task`) to take the highest-priority ready issue.

Backlog lives in **Linear**, not in a `tasks/` folder. This is the companion to `review-task`
(which grooms issues and applies the `"Ready to play"` label) and `create-task` (which files
them). An issue is ready for this skill exactly when it carries the **`"Ready to play"`** label.

## Context discipline (why the review passes are subagents)

Steps 7–9 are the context hogs: each one reads broad swathes of the codebase, and by the time
thermos runs, the main thread is carrying every file the earlier passes opened. It doesn't need
any of them — it only needs to know *what changed and why*.

So **every review pass runs in a subagent**, and the main thread keeps only the summary. The
subagent burns its own context reading files; you receive ~20 lines instead of ~20k tokens. The
main thread stays the orchestrator: it owns the gates, the git operations, and the running list of
thermos findings for the PR comment.

Two rules make this safe, and they are not optional:

- **Subagents never run git.** No `git add`, no `git commit`, no `git stash`, no branch
  operations. Parallel agents sharing one working tree will collide on `index.lock` and interleave
  each other's staged files. The main thread does every commit, after the agents return.
- **Subagents stay inside their file domain.** The parallel passes in Step 7 run concurrently
  against one working tree, so their domains are carved to not overlap. Anything an agent wants to
  change outside its own domain it **reports** rather than edits, and the main thread applies it.

## Prerequisites
Linear MCP tools (`mcp__claude_ai_Linear__*`) must be available. If not, tell the user to connect
the Linear connector in claude.ai settings and stop.

## Step 0 — Resolve the target Linear project & team
Each repo maps to exactly one Linear project. Figure out which:
1. Identify this repo — its git remote basename, root folder name, or `package.json` name
   (e.g. `git remote get-url origin`, or the working directory name).
2. `mcp__claude_ai_Linear__list_projects` and find the project whose name matches this repo.
   Match **loosely** — casing/separators differ (`tubekeep` repo → `Tubekeep` project).
3. If the match is ambiguous, the project looks renamed, or you're unsure, **stop and ask** which
   Linear project to use. Never guess silently.
4. Derive the **team** from the resolved project (a project belongs to a team) — you'll need it
   for label and status lookups.

## Step 1 — Resolve which issue
- **Identifier given** (e.g. `0XC-12`, case-insensitive): `mcp__claude_ai_Linear__get_issue` for
  it. If it isn't in the resolved project, or doesn't exist, say so and stop. It does **not** need
  the `"Ready to play"` label when named explicitly — the user asked for it by name — but if its
  status is already `In Progress`, `In Review`, `Done`, or `Canceled`, surface that and confirm
  before proceeding (it may already be underway elsewhere).
- **No identifier**: `mcp__claude_ai_Linear__list_issues` filtered to the resolved team/project,
  **label `"Ready to play"`**, and **statuses `Backlog` + `Todo` only** (exclude In Progress /
  In Review / Done / Canceled — those are taken or finished). Sort by **priority** (Urgent → High
  → Medium → Low → None); break ties by **oldest `createdAt`** first. Pick the top one. If nothing
  matches, tell the user there are no ready issues (suggest running `review-task` to groom the
  backlog) and stop.

Read the whole issue — title, description, and `mcp__claude_ai_Linear__list_comments` — so you
have the full acceptance criteria and any grooming notes before planning.

## Step 2 — Plan (no confirmation gate)
Restate your understanding in 2–4 sentences and lay out a short implementation plan keyed to the
issue's **Acceptance criteria**. This is context for the user, **not** a gate: state the plan and
**immediately proceed** to create the workspace and write code — do not pause to ask "shall I
proceed?" or wait for approval. Invoking this skill *is* the go-ahead. Stop for the user only when
you hit a genuine blocker (an ambiguous Linear project in Step 0, a missing/taken issue in Step 1,
or an acceptance criterion that's infeasible or wrong) — never merely to confirm the plan itself.

## Step 3 — Choose the workspace, then move the issue to In Progress
Decide **worktree vs. local branch** based on whether another task is already in flight, then
create the workspace and set the Linear issue's status to **In Progress**.

### 3a — Is another task already in flight?
Check this **before** you move the current issue to In Progress. Another task is in flight if
**any** of these is true (`git worktree list` is the most reliable signal):
- `git worktree list` shows a worktree **other than** the main repo, **or**
- the main checkout is on a **non-default branch** or has uncommitted changes (already busy), **or**
- another Linear issue in this project is already `In Progress` on a branch that exists locally.

### 3b — No other task in flight → **local branch** (no worktree)
Work directly in the main checkout — its deps and gitignored env files are already in place, so
the user can run/test the app immediately.
1. Derive the **branch** name: `<prefix>/<identifier-lower>-slug`, where `prefix` maps from the
   issue's **type label** — `Feature→feat`, `Bug→fix`, `Improvement→refactor`, and default `feat`
   otherwise. `slug` is a short kebab-case of the title. Example: `feat/0xc-12-share-button`.
2. `git fetch origin && git switch -c <branch> origin/main` (branch off up-to-date `main`).

### 3c — Another task is in flight → **isolated worktree**
Isolate this task so the parallel work doesn't collide.
1. Derive names from the issue:
   - **Worktree dir**: `../<repo>-worktrees/<identifier-lower>-slug` (sibling of the repo).
   - **Branch**: `<prefix>/<identifier-lower>-slug` (same prefix mapping as 3b).
2. Create it off the up-to-date default branch:
   `git fetch origin && git worktree add ../<repo>-worktrees/<identifier-lower>-slug -b <branch> origin/main`
3. From here on, **run every command inside the worktree dir** (use absolute paths / `git -C`;
   avoid `cd` where the harness would prompt). This includes the Step 7–9 subagents: pass each one
   the absolute worktree path and tell it to work there.
4. Install deps in the worktree — a fresh worktree has no `node_modules` until you install: run the
   repo's install command (e.g. `npm install`, or `pnpm install` at the root for a pnpm monorepo).
5. **Copy gitignored env files so the app runs locally.** A fresh worktree is a clean checkout and
   has none of the gitignored `.env*` files the app needs. Copy each from the main repo into the
   same relative path in the worktree:
   ```
   git -C <main-repo> ls-files --others --ignored --exclude-standard \
     | grep -E '(^|/)\.env' \
     | while read -r f; do
         mkdir -p "<worktree>/$(dirname "$f")"
         cp "<main-repo>/$f" "<worktree>/$f"
       done
   ```
   Confirm afterward that each expected env file landed in the worktree.

### 3d — Move to In Progress (both paths)
Set the Linear issue's status to **In Progress** via `mcp__claude_ai_Linear__save_issue`
(`state: "In Progress"`), and post a short comment (`mcp__claude_ai_Linear__save_comment`) noting
the branch you're working on so the issue links to the work. Leave the `"Ready to play"` label in
place. (Do **not** move it to `Done` yet — that happens only after the PR merges, Step 13.)

## Step 4 — Implement (TDD)
Work **test-first** where the project has a test setup: for each testable acceptance criterion,
write a failing test, make it pass, then refactor. Cover the new behavior with tests before moving
on. If the repo has **no test framework** (check `package.json` / `CLAUDE.md`), say so and verify
behavior by running the app instead.

Build the task to satisfy **every** acceptance criterion. Follow the codebase conventions in
`CLAUDE.md`. When a criterion is genuinely infeasible or wrong, stop and flag it (comment on the
Linear issue) rather than silently skipping.

## Step 5 — Update docs & verify (before committing)
Two gates must both pass **before** you commit (and well before the PR):

1. **Docs** — create or update any documentation the change makes necessary: `CLAUDE.md`
   (architecture/conventions), the relevant `README.md`(s), `.env.example` for new env vars, and
   inline doc comments. Don't leave docs describing the old behavior.
2. **Build, lint, and tests all green** — run and confirm using **this repo's actual commands**
   (from `CLAUDE.md` / `package.json` / CI config), fixing every failure before proceeding:
   build/typecheck, lint, and the test suite (including the tests you added for this task). If the
   repo has no build or no tests, run whatever gates it does have (e.g. `npm run lint`).

   **Never open the PR with a red build, failing lint, or failing tests.**

## Step 6 — Commit the implementation
Once docs and the Step 5 gates are green, stage and commit with a conventional message
(`<prefix>: <title> (<identifier>)`, e.g. `feat: add share button (0XC-12)`). End the commit
message with:
`Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`

**Do not open the PR yet** — the review passes (Steps 7–9) plus the full test gate (Step 10) run
first, on the committed branch, so the PR opens already-reviewed.

From here on you are an **orchestrator**: the passes run in subagents, and you own the gates and
the commits. Commit after each of Steps 7, 8, and 9 (conventional message + the same
`Co-Authored-By:` footer); if a step changed nothing, say so and skip its commit.

## Step 7 — Review passes in parallel subagents (docs, coverage, a11y, SEO)

Launch these as **subagents in a single message** so they run concurrently, then **wait for all of
them to return** before doing anything else. Skip any pass that doesn't apply and say so — don't
spawn an agent just to have it report "not applicable".

Give every agent this **common contract**, verbatim in spirit:

> Work in `<absolute repo-or-worktree path>`. The change under review is the diff of the current
> branch vs `origin/main` — start from `git diff origin/main...HEAD` to scope yourself.
> **Do not run any git command that writes** (no add/commit/stash/checkout/branch) — read-only git
> is fine. Edit **only** files in your assigned domain; anything you'd change outside it, list in
> your report instead of editing. Return **only**: (a) files you changed, one line each on why,
> (b) anything you chose not to change and why, (c) anything outside your domain that needs
> attention. No diffs, no file contents, no narration.

The four passes and their **disjoint domains**:

| Pass | Skill to run | Domain it may edit | Skip when |
|---|---|---|---|
| **Docs** | — | `*.md` only (`CLAUDE.md`, `README.md`(s)), `.env.example` | never (always applies) |
| **Coverage** | `*-integration-testing` (see below) | test files only (`__tests__/`, `*.test.*`, `*.spec.*`, test config/mocks) | repo has no test framework |
| **A11y** | `reviewing-a11y` | the changed UI components/pages themselves | change touches no web or mobile UI |
| **SEO/GEO/AEO** | `seo-geo-aeo` | page-level metadata, structured data / JSON-LD, head tags | change touches no user-facing web content |

Per-pass notes:

- **Docs** — re-check project docs now that the implementation is final; this catches what the
  Step 5 docs gate missed. Don't leave any doc describing the old behavior.
- **Coverage** — confirm the change is covered by **unit** *and* **integration** tests and add
  what's missing, test-first where practical. Pick the integration layer from the **type of
  change** and follow that skill's rules: API / route handlers / server logic →
  `api-integration-testing`; web UI / pages / components → `webapp-integration-testing`;
  React Native screens / navigation / stores → `react-native-integration-testing`. (All three
  build on the shared `base-integration-testing` skill — apply it too.)
- **A11y** — check WCAG 2.2 / WAI-ARIA roles and ADA concerns, and fix what surfaces (labels,
  roles, contrast, focus order, …).
- **SEO/GEO/AEO** — meta tags, structured data, headings, answer-engine readiness; apply the fixes
  that fit the change.

**A11y and SEO both touch UI** — if the change has both web UI *and* user-facing web content, the
domain split is: a11y owns component internals (roles, labels, focus), SEO owns page-level head /
metadata / structured data. If they'd genuinely need the same lines, run SEO **after** a11y
returns rather than alongside it, and say why.

Once all agents have returned:
1. Review their reports and apply anything they flagged as outside-my-domain.
2. Re-run the **Step 5 gates** and fix any failure the passes introduced.
3. **Commit**, one commit per pass that changed something, so history stays legible:
   `docs: update docs for <identifier>` / `test: cover <identifier>` /
   `fix: a11y for <identifier>` / `fix: seo/geo/aeo for <identifier>`.

## Step 8 — Simplify (subagent)

Only after Step 7 is committed — simplify must see the final code, including the tests and fixes
the parallel passes added.

Run the **simplify** skill (`/simplify`) **in a single subagent** to review the changed code for
reuse, simplification, efficiency, and altitude cleanups, and apply its fixes. Simplify is
quality-only — the thermos pass in Step 9 hunts bugs. Give it the same common contract as Step 7
(no git writes, report-only output), but its domain is **any file the branch already touches** —
it's the only agent running, so there's nothing to collide with. It must not expand the change's
blast radius to untouched files.

When it returns:
- Re-run the **Step 5 gates** and fix any failure simplify introduced.
- Commit (`refactor: simplify <identifier>`, same footer). If simplify changed nothing, say so and
  skip the commit.

## Step 9 — Thermos review & fix findings (subagent)

Only after Step 8 is committed — thermos reviews what actually ships.

Run the **thermos** skill (`/thermos`) **in a subagent**, on the branch diff (vs `origin/main`).
It launches the two thermo-nuclear reviewers (bug/security/breakage + code-quality) in parallel and
synthesizes prioritized findings (P0 blocking → P3 nit).

Have the subagent **report the findings without fixing them** — return the full list as
`severity | file:line | one-line description`, nothing else. You apply the fixes in the main
thread, because which findings get fixed vs. deferred is a judgment call that has to survive into
the PR comment:

- Fix **all P0 and P1** findings.
- Fix **P2** findings that are easy; leave the rest noted.
- Do any **easy cleanups** the review surfaces while you're in there.
- Whatever is **left** (deferred P2s, P3s) is recorded and posted as a PR comment when the PR is
  opened (Step 11) — nothing is dropped silently.
- Re-run the **Step 5 gates** after fixing, then commit (`fix: address thermos findings
  (<identifier>)`, same footer). If there was nothing to fix, skip the commit.

Keep a short written list of the thermos findings (severity, file:line, **fixed** vs. **deferred**
with a one-line reason) to paste into the PR comment in Step 11. This list is the one thing you
must carry in the main thread — everything else can stay in the subagents.

## Step 10 — Full test gate (unit + e2e integration)
Before opening the PR, run the **complete** test suite — unit **and** end-to-end integration — for
every part the change touched, and confirm all pass. If the project's default test command
**excludes** integration suites, run them explicitly (check `CLAUDE.md` / CI config for the exact
commands). If the repo has no tests, run its available gates (build + lint) instead and say so.

Run this in the **main thread**, not a subagent — you need the actual failures, and a passing run
is a handful of lines.

If anything is red, **fix it** (the test or the code, whichever is wrong), re-run until everything
passes, and **commit the fixes** (`test: fix tests for <identifier>` or `fix: … (<identifier>)`,
same footer). **Never open the PR with any unit or integration test failing.** If nothing needed
fixing, say so and skip the commit.

## Step 11 — Open the PR, post the review, move to In Review, and watch CI to green
1. Push the branch and open the PR with `gh pr create`. The PR body should summarize the change,
   restate the acceptance criteria as a checklist, include a **`## How to test`** section (see
   below), and **link the Linear issue** (include its identifier and URL — Linear auto-links PRs
   that reference the identifier). End the PR body with:
   `🤖 Generated with [Claude Code](https://claude.com/claude-code)`

   **The `## How to test` section is required — never omit it.** Write it *for the user*, as
   concrete numbered steps they can follow to verify the change by hand, not a description of the
   automated tests. Cover, as they apply to this change:
   - **Setup** — any prerequisite to exercise it (branch checkout, `pnpm install`, env vars,
     `pnpm --filter web db:migrate`/seed, which dev server to start and how — `pnpm dev`,
     `pnpm mobile`, etc.).
   - **Steps to reproduce the new behavior** — the exact route/URL, screen, API call
     (a copy-pasteable `curl` for API changes, with sample request/response), or UI interaction,
     spelled out click-by-click.
   - **Expected result** — what the user should see or get if it works, including the *before*
     (old behavior) where it clarifies what changed.
   - **Edge cases / regressions to sanity-check** worth a manual look.
   Be specific to *this* change — no generic boilerplate. If a criterion is only verifiable via the
   automated suite, say which command runs it and what a pass looks like.
2. Capture the PR URL/number from `gh`.
3. **Move the Linear issue to `In Review`** via `mcp__claude_ai_Linear__save_issue`
   (`state: "In Review"`), and post the PR link as a comment (`save_comment`).
4. **Post the thermos review as a single PR comment for the record** (`gh pr comment <url>
   --body …`): list the findings by severity with file:line, marking each **fixed** or
   **deferred** (one-line reason for anything left). If the review came back clean, say so.
5. **Watch the CI build until it finishes successfully — do not hand off on a red or pending
   build.** Poll the PR's checks (`gh pr checks <url> --watch`, or repeated `gh pr checks <url>` /
   `gh run list` / `gh run watch`) until every required check has completed.
   - **All checks pass** → continue to Step 12.
   - **A check fails** → inspect the failing run (`gh run view <run-id> --log-failed`), diagnose the
     cause, **fix it on the branch** (never just re-run a genuinely red build), re-run the relevant
     local gate to confirm, then commit (`fix: … (<identifier>)`, same footer) and push. Watch the
     new CI run and repeat until CI is fully green.
   - If CI stays red after a reasonable effort, or fails for an infra/flake reason outside the
     change, **stop and tell the user** with the failing run link and what you found rather than
     handing off as if it passed.

## Step 12 — Report & hand off (await merge)
Give the user: the PR link, a one-line summary of what was built, **confirmation that CI is green**
(from Step 11.5), the review findings by severity, what you fixed vs. deferred (with reasons), the
Linear issue (identifier + that it's now `In Review`), and the workspace (branch, plus worktree
path if one was created). The issue is **In Review, not Done**.

**Do not merge the PR, and do not move the issue to Done.** Tell the user explicitly: *"Tell me
once the PR is merged and I'll finalize the task (move the Linear issue to Done and clean up the
worktree)."* Then stop and wait for that confirmation.

## Step 13 — (When the user says the PR merged) Finalize the issue
Only run this once the user confirms the **PR is merged**.

1. **Sync the main checkout** to the merged state:
   ```
   git -C <main-repo> fetch origin
   git -C <main-repo> checkout main        # if it was left on the feature branch (local-branch case)
   git -C <main-repo> pull --ff-only origin main
   ```
2. **Move the Linear issue to `Done`** via `mcp__claude_ai_Linear__save_issue`
   (`state: "Done"`). Post a closing comment (`save_comment`) linking the merged PR. Leave the
   `"Ready to play"` label as-is — the `Done` status is the source of truth for completion.

## Step 14 — (When the user says the PR merged) Clean up the workspace
Done alongside Step 13, after the PR merged.

- **Worktree case**: remove the worktree and delete its folder, then delete the now-merged local
  feature branch:
  ```
  git -C <main-repo> worktree remove ../<repo>-worktrees/<identifier-lower>-slug
  git -C <main-repo> branch -d <feature-branch>
  ```
  (Use `git worktree remove --force` only if it refuses due to leftover untracked files — e.g. the
  copied env files — and call that out.) GitHub usually deletes the remote branch on merge; if it
  didn't, `git -C <main-repo> push origin --delete <feature-branch>`.
- **Local-branch case**: you're already back on `main` from Step 13; just delete the merged feature
  branch: `git -C <main-repo> branch -d <feature-branch>`.

Finally, report to the user: the Linear issue is `Done`, the merged PR link, and that the workspace
was cleaned up.
