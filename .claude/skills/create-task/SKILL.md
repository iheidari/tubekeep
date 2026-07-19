---
name: create-task
description: Interview the user about a piece of work, file it as a fully-specified issue in the current repo's Linear project, then run it through review-task to size and mark it "ready to play" for implementation. Use when the user wants to create/file/add a task, or invokes /create-task.
disable-model-invocation: true
---

Turn a rough idea into a cold-readable **Linear issue** in the Linear project that corresponds
to the current repo. The goal is an issue a future Claude session (with **zero memory** of any
conversation) can pick up and execute without asking follow-ups. So the interview must surface
every detail now.

There is **one Linear project per repo** (e.g. this repo → its matching project). This skill's
job is to resolve that project, interview until the work is fully specified, create the issue
there, then hand it to **review-task** to size it and mark it **`"ready to play"`** — not to
write a file. It stops short of implementing the task.

The user's starting idea is in the skill arguments (what they typed after `/create-task`).
If empty, ask one question: "What's the task?" — then proceed.

## Step 0 — Resolve the target Linear project (do this first, before creating anything)
Each repo maps to exactly one Linear project. Figure out which:
1. Identify this repo — its git remote basename, root folder name, or `package.json` name
   (e.g. `git remote get-url origin`, or the working directory name).
2. List Linear projects (`mcp__claude_ai_Linear__list_projects`) and find the one whose name
   matches this repo. Match **loosely** — casing and separators differ (a `true-north-prep`
   repo maps to a `TrueNorthPrep` project; `milemark` → `Milemark`; `tubekeep` → `Tubekeep`).
3. **Confirm before using it.** State the project you resolved ("Filing into Linear project
   **X** — correct?") and let the user redirect. The repo→project mapping is a heuristic, so a
   quick confirm is required, not optional.
4. **If you can't find a matching project, the match is ambiguous (several plausible), the
   project looks renamed, or you're otherwise not sure — STOP and ask the user which Linear
   project to file into.** Never guess silently, and never fall back to writing a task file.

Once the project is confirmed, derive the **team** from that project (a project belongs to a
team) — you'll need the team to create the issue and to look up labels/statuses.

## Step 1 — Ground it in the codebase first
Before asking the user anything, explore the repo to answer what you can yourself:
the relevant files, current behavior, related components, existing patterns. **Never ask the
user something the codebase already answers** — find it. Note the repo's typecheck/lint/build
commands (from `package.json`, CLAUDE.md, or CI config) so you can cite the real gates later.

## Step 2 — Grill for the rest
Invoke the **grill-me** skill (via the Skill tool) to interview the user one question at a
time until the task is fully resolved. For each question, propose your recommended answer.
Drive the interview toward filling, concretely:
- **Context** — why this matters, where it lives (cite `file:line`), current behavior.
- **Goal** — what "done" looks like from the user's POV, in 1–2 sentences.
- **Acceptance criteria** — observable, checkable outcomes. Include this repo's real gates
  (the typecheck/lint/build commands you found in Step 1).
- **Notes / constraints** — gotchas, things NOT to do, related work to link (reference other
  Linear issues by their identifier, e.g. `ABC-12`).

Stop grilling once you could hand the issue to a stranger and they'd know exactly what to build.

## Step 3 — Classify type & confirm priority
Two Linear fields still need to be set from the interview:

- **Type → label.** Infer the type from the request, then map it to one of the team's labels
  (list them with `mcp__claude_ai_Linear__list_issue_labels` for the resolved team):
  - `feature` ("add Y") → **Feature**
  - `bug` ("fix X is broken") → **Bug**
  - `chore` / `refactor` / `docs` (deps/config bump, restructure with no behavior change,
    README/docs) → **Improvement**

  If you can recognize the type confidently, **set the label and tell the user** what you
  picked (so they can override). If it's genuinely ambiguous, **ask**. If the team's label set
  doesn't include a matching label, ask which to use rather than inventing one.
- **Priority.** **Always ask the user explicitly** as the final question, proposing a
  recommended level. Map their answer to Linear's numeric priority:
  `urgent → 1`, `high → 2`, `medium → 3`, `low → 4` (`none → 0`).

## Step 4 — Attach any external references
If the task depends on something outside the repo — a design handoff URL, an image, a spec/PDF,
a sample dataset, a related doc — make it reachable from the issue so a cold reader needs no
prior context:
- Put durable links inline in the issue description, and/or add them as attachments via
  `mcp__claude_ai_Linear__save_issue`'s `links: [{ url, title }]`.
- For binary assets that must survive offline (a screenshot, a tarball), upload them with the
  Linear attachment-upload tools (`prepare_attachment_upload` /
  `create_attachment_from_upload`) and reference the resulting attachment — do **not** leave
  the only copy behind a link that may rot.

## Step 5 — Create the Linear issue
Call `mcp__claude_ai_Linear__save_issue` **without an `id`** (creating, not updating) with:
- `team`: the team of the resolved project (Step 0).
- `project`: the confirmed project (name or id).
- `title`: a short imperative summary of the task.
- `description`: Markdown with the full spec from the interview — use these sections so the
  issue is cold-readable: **Context**, **Goal**, **Acceptance criteria** (checklist), and
  **Notes / constraints**. Write literal newlines, not `\n`. Cite `file:line` where relevant.
- `labels`: the type label from Step 3 (`Feature` | `Bug` | `Improvement`).
- `priority`: the number from Step 3.
- `state`: the team's `Todo` status (the unstarted "ready to pick up" column). If the team has
  no such status, pick the closest unstarted/backlog status and say which you used.
- `links`: any external references from Step 4.

Linear assigns the identifier (e.g. `ABC-42`) — do not invent one. There's no file to write and
no number to reserve; issue numbering and collision-safety are Linear's job.

## Step 6 — Review & finalize the new issue
Immediately after creating the issue, run it through review so it comes out of this skill
already implementation-ready. Invoke the **review-task** skill (via the Skill tool), scoped to
**only the issue you just created** — pass its identifier (e.g. "review-task ABC-42") so it
grooms that single issue, not the whole backlog. That pass will:
- size the issue with a T-shirt `estimate`,
- spin off any `"Dev Task"` sub-issues for manual developer-setup dependencies, and
- apply the **`"ready to play"`** label once there are no open blocking questions — which is
  what marks the issue ready to start implementing.

Because Steps 1–5 already grilled the task to a cold-readable spec, review-task usually has no
gaps left to resolve and mostly just sizes + labels it — but if it does surface an open
question, resolve it live there. If review-task cannot reach `"ready to play"` (a blocking
question was deferred), say so in Step 7 instead of claiming the task is ready.

## Step 7 — Confirm
Show the created issue's **identifier, title, and URL** (from the `save_issue` result) plus a
short summary of what you captured, its T-shirt size, any `"Dev Task"` sub-issues spun off in
Step 6, and whether it reached the **`"ready to play"`** state. Do **not** start implementing
the task — this skill only files and finalizes it. Mention the user can now say "do task
<identifier>" (e.g. "do task ABC-42") to execute it.
