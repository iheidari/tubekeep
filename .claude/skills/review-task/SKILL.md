---
name: review-task
description: Groom a Linear backlog by reviewing each task for implementation-readiness, filling gaps, sizing, and labeling. Use when the user wants to review, groom, refine, or triage Linear tasks/issues/backlog, check if tasks are ready to implement, add estimates/shirt sizes, or runs review-task.
---

# review-task

Sweep a Linear project's backlog, one issue at a time (highest priority first), and make each
issue implementation-ready: clarify gaps, add detail, size it, and mark it reviewed so it's
skipped next run.

**Work strictly one issue at a time.** Fully finish an issue — resolve its gaps live, rewrite the
description, size it, label it — *before* touching the next one. Don't sweep through and drop a
batch of question-comments on many issues; refine one, then move on to the next.

## Prerequisites

Linear MCP tools (`mcp__claude_ai_Linear__*`) must be available. If not, tell the user to connect
the Linear connector in claude.ai settings and stop.

## Workflow

1. **Pick scope.** Resolve the target project in this order, and **only ask the user to confirm
   scope when a step below explicitly says to**:
   - If the user named a team/project, use it.
   - Otherwise, if the session is running inside a repo/project folder, infer the project from it
     (repo name / directory name, matched against `list_projects`) and **use it without asking**.
     If the inferred name matches exactly one Linear project, proceed silently. If it matches
     none or is ambiguous, fall through to the ask case below.
   - **Ask the user which to review (via `list_teams` / `list_projects`) only if:** (a) the
     session is not inside any repo/project folder, or (b) the inferred project has no reviewable
     issues left — i.e. every Backlog/Todo issue already carries the `"ready to play"` label. In
     case (b), tell the user everything is already reviewed and ready before asking whether to
     pick a different scope.

   Confirm the `"ready to play"` and `"Dev Task"` labels exist via `list_issue_labels`; if either
   is missing, create it with `create_issue_label`. (`"Dev Task"` tags the sub-issues you spin off
   in step 5 for manual developer setup.)

2. **Fetch the queue.** `list_issues` filtered to the chosen team/project, **statuses Backlog +
   Todo only** (exclude In Progress / Done / Canceled), and **excluding issues that already carry
   the `"ready to play"` label** — those are done, never re-review them. Sort by priority
   (Urgent → High → Medium → Low → None). Announce the count and the order.

3. **Review each issue in priority order.** For each, read title + description (and
   `list_comments`) and judge: *could an engineer start implementing from this alone?* Assess
   scope, acceptance criteria, affected areas, edge cases, dependencies, and design/UX needs.
   See [REVIEW-RUBRIC.md](REVIEW-RUBRIC.md) for what "ready" means.

4. **Resolve gaps live, then finish this issue before moving on.** Collect every open question for
   the issue and ask the user **right now** with `AskUserQuestion` — don't post them as a Linear
   comment and sweep on. Take the issue all the way to done (questions answered → description
   rewritten → sized → labeled) *before* advancing to the next one. Do not open questions on
   several issues at once or leave a trail of comments behind.
   - **Ask live.** Put the issue's open questions to the user via `AskUserQuestion`, batching them
     into that one prompt (up to 4 questions) rather than many separate prompts. **Every question
     must offer answer options where the choices are enumerable** — don't ask open-ended questions
     when you can propose concrete alternatives. Put the recommended option first and append
     "(Recommended)" to its label; `AskUserQuestion` always allows a free-form "Other" reply. Only
     leave a question option-less when the answer is genuinely open (e.g. "what should the copy
     say?") — ask those in prose in your turn.
   - **If the issue is too big** (likely needs splitting), raise that live first (see
     [REVIEW-RUBRIC.md](REVIEW-RUBRIC.md)) before asking the detail questions.
   - **Fold the answers into the description** via `save_issue` — rewrite it to stand alone; don't
     paste a raw Q&A transcript. See the format in [REVIEW-RUBRIC.md](REVIEW-RUBRIC.md).
   - **Comment only as a fallback.** If the user steps away or explicitly defers an issue, record
     its open questions in a single Linear comment (`save_comment`) so it resurfaces next run, then
     move on. This is the exception — the default is to resolve live and never leave the issue with
     open comments.

5. **Break out developer setup dependencies into sub-issues.** While resolving gaps, watch for
   dependencies that are **manual setup a developer must do outside the code** before (or
   alongside) the feature can be built — provisioning infrastructure, creating third-party
   accounts/projects, OAuth clients, databases, API keys/credentials, DNS, secrets, etc. These are
   prerequisite chores, not part of the coding task itself. For **each** such dependency, create a
   dedicated **sub-issue of the current issue**:
   - `save_issue` with `parentId` = the current issue's identifier (e.g. `OXC-18`), `team` = the
     same team, a concrete actionable `title` (e.g. "Create Google OAuth client"), and
     `labels: ["Dev Task"]`.
   - Write a `description` that says exactly **what to do**: where to do it (which console/provider),
     the settings that matter, and what output the feature needs back (e.g. the client ID/secret,
     the connection string) and where it should land (env var / secret store).
   - In the parent issue's description, list these sub-issues under its **Dependencies** section so
     the link is explicit.

   Example — for **OXC-18** (a Google-login feature) you'd spin off two `"Dev Task"` sub-issues:
   (1) *Create Google OAuth client* — set up an OAuth 2.0 client in Google Cloud Console, configure
   the authorized redirect URIs, hand back the client ID + secret. (2) *Create Neon database* —
   provision a Neon Postgres project/branch and provide the connection string as a secret.

   Only create these when the setup is genuinely a human/manual prerequisite; ordinary code
   dependencies on other tickets stay as issue relations, not `"Dev Task"` sub-issues.

6. **Size it (T-shirt).** Set the native Linear `estimate` field on the issue via `save_issue`.
   The team uses the **T-shirt scale**, which the API takes as a *number* (you cannot send the
   string "M"). Linear's T-shirt scale is a display style over its 1–5 linear scale, so map:
   **XS=1, S=2, M=3, L=4, XL=5.** Note the shirt-size letter in the review comment so it's
   human-readable. On the first sizing of a run, verify the mapping by reading the issue back with
   `get_issue` and confirming the estimate stuck as expected; if the team turns out to use a
   different scale, adjust before continuing.

7. **Mark reviewed** — but only when the issue is actually ready. Add the `"ready to play"` label
   via `save_issue`. Because you resolved the questions live in step 4, this normally happens
   before you move to the next issue. **Only apply it when there are no open blocking questions** —
   if the user deferred and you left a fallback comment, leave the label off so the issue
   resurfaces next run. Never re-add if already present.

8. **Then move to the next issue** and repeat steps 3–7. After the whole sweep, summarize:
   reviewed / labeled-ready / deferred, with the shirt size, any `"Dev Task"` sub-issues spun off,
   and any open questions per issue.

## Rules

- One issue at a time, strict priority order — fully finish one before starting the next. Don't
  batch-label or batch-comment across issues.
- Resolve gaps live with `AskUserQuestion`; a Linear comment is only a fallback for when the user
  defers an issue.
- Manual developer-setup dependencies (create an OAuth client, provision a database, get an API
  key) become `"Dev Task"`-labeled sub-issues of the current issue, each with what-to-do detail —
  don't bury them in the parent description.
- Never label an issue `"ready to play"` while it still has unanswered blocking questions.
- Editing a description means rewriting it to stand alone, not appending a Q&A transcript.
- Idempotent: re-running skips anything already labeled `"ready to play"`.
