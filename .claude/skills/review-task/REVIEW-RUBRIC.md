# Review rubric — "is this task ready to play?"

An issue is **ready** only if an engineer unfamiliar with the ticket could pick it up and
implement it without asking anyone. Check each dimension; anything unclear becomes a question.

## Readiness checklist

- **Goal / why** — Is the outcome and the reason for it clear? (Not just *what*, but *why now*.)
- **Scope boundaries** — What's explicitly in and out? Is it one task or several disguised as one?
- **Acceptance criteria** — How do we know it's done? Concrete, testable conditions.
- **Affected surface** — Which parts of the codebase/UI/API/data does it touch? Named, not vague.
- **Edge cases & errors** — Empty/failure/loading/permission/offline states considered?
- **Dependencies** — Blocked by other work, external services, decisions, or credentials? If a
  dependency is **manual developer setup** (provision a database, create an OAuth client, get an
  API key/secret, register a third-party app), spin it off as a `"Dev Task"`-labeled **sub-issue**
  of the current ticket with a clear what-to-do description — see step 5 in SKILL.md. Code
  dependencies on other tickets stay as issue relations.
- **Design / UX** — For anything user-facing: is there a mock, copy, or a clear description? If
  not, that's a gap.
- **Data / contracts** — New fields, endpoints, migrations, or response shapes specified?
- **Non-functional** — Any perf, security, accessibility, or rollout constraints that matter?

If every relevant box is answerable from the ticket → ready (size it, label it).
If any is unanswerable → it's a live question (ask the user now with `AskUserQuestion`), not a
comment to leave behind.

## Too big → split, don't just size

Signals an issue should be split rather than sized as one XL:
- Multiple independent acceptance criteria that could ship separately.
- Touches unrelated subsystems (e.g. backend service + unrelated UI page).
- The word "and" joining distinct deliverables in the title.
- You'd estimate it larger than the team's XL.

When you spot this, raise it **live** (`AskUserQuestion`) before sizing — ask whether to split,
and if yes, propose the sub-tasks. Splitting is a decision for the user, not something to do
silently.

## Shirt sizing guide (T-shirt scale)

Judge relative effort + uncertainty, not just lines of code. The Linear API takes `estimate` as a
number, so send the mapped value (in parentheses) — the letter is only for the human-readable note.

- **XS (1)** — trivial, well-understood, <½ day. Copy tweak, config, one-liner.
- **S (2)** — small, clear, ~1 day. Single component/endpoint, no unknowns.
- **M (3)** — a few days. Multiple files or a small feature slice; minor unknowns.
- **L (4)** — ~a week. Cross-cutting change, several moving parts, some design needed.
- **XL (5)** — larger/uncertain. Strong candidate to split before it's "ready".

High uncertainty bumps the size up a notch — an unclear M is really an L.

## Asking the questions (live, one issue at a time)

Ask the open questions for the *current* issue with `AskUserQuestion` before moving on — don't
leave them as a comment. Batch an issue's questions into a single `AskUserQuestion` prompt (up to
4 at once). Give every question enumerable answer options, put the recommended one first with
"(Recommended)" in its label; the tool always offers a free-form "Other" reply. Example set of
questions for one issue:

- **How does the user trigger the upload?** — A button on each completed download (Recommended) /
  A global auto-upload setting / Both
- **Auth model for the provider?** — Per-user OAuth, tokens stored server-side (Recommended) /
  Single shared service account
- **After a successful upload, what happens to the local file?** — Expire it (existing
  expire-vs-delete lifecycle) (Recommended) / Keep both copies

Once the user answers, fold the answers into the description and size the issue. **Fallback only:**
if the user defers the issue, drop the still-open questions in one Linear comment (numbered list,
lettered options, `Other: ___`) so it resurfaces next run — then move on.

## Writing the description update

When answers come in, rewrite the description so it stands alone:
- Lead with the goal and acceptance criteria.
- Fold answers into the relevant section — don't leave a raw "Q: … A: …" transcript.
- Keep the original intent; add, don't overwrite the requester's context.
