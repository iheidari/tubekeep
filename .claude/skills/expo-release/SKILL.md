---
name: expo-release
description: Cut a release for the Expo / React Native mobile app — pick the platform and version, generate the store "what's new" notes, update CHANGELOG.md, and create the release branch + git tag + GitHub release. Use when the user wants to release, ship, or cut a new mobile / Expo version, bump the app version, prepare release notes, or runs expo-release. Replaces the manual build.sh release flow.
---

# expo-release

Orchestrates a mobile release end-to-end: **platform → version → notes → branch +
auto-merged PR → tag → EAS build**. The helper scripts handle the deterministic
parts (version discovery, file patching); you curate the human-readable notes.

This skill runs the whole flow without stopping for approval at the merge or build
steps: it **auto-merges** the release PR and **always triggers** the EAS build,
printing the build link(s) at the end.

## Inputs (args, else ask)

- **platform** — `ios` | `android` | `all`. If not given, ask with `AskUserQuestion`.
- **version** — SemVer like `2.1.0`. If not given, recommend one (see step 2) and ask.

## Workflow

Run everything from the **repo root**. Let `SK=~/.claude/skills/expo-release`.

1. **Preflight.** Confirm the working tree is clean and you're on `main` in sync with
   `origin/main` (`git fetch -q origin main` then compare). If on another branch, out
   of sync, or the tree is dirty, **warn and ask before continuing** — don't abort silently.

2. **Resolve version.** Run `node "$SK/scripts/release-info.mjs"` → JSON with `current`,
   `lastTag`, `suggested`, `suggestedBump`, and `commits[]` (subjects since the last tag).
   If the user passed a version, use it. Otherwise ask with `AskUserQuestion`, listing
   `suggested` **first** as "(Recommended)" with the bump reason, plus the other two
   bump levels. If `current`'s tag already exists, see [REFERENCE.md](REFERENCE.md) (amend vs. patch).

3. **Write the notes** from `commits[]`. Two outputs (curate — don't dump raw subjects):
   - **`<appDir>/CHANGELOG.md`** — prepend a `## [<version>] - <today>` section in
     Keep a Changelog style (Added / Changed / Fixed / Moderation & Security), each
     line ending with its `(#NN)` PR number.
   - **`<appDir>/release-notes/<version>.md`** — short, user-facing App Store / Play
     "What's New" copy (plain language, bullets, no PR numbers).

4. **Bump the version.** `node "$SK/scripts/set-version.mjs" <version>` (patches
   `package.json` + `app.config.ts`).

5. **Branch, commit, push, PR, auto-merge.** Branch `release/mobile-<version>`, commit
   the version bump + notes, push, and `gh pr create` (base `main`). Commit message + PR
   body: summarize the release; end the commit with the `Co-Authored-By` trailer and the
   PR body with the Claude Code footer (per repo conventions). Then **auto-merge without
   asking** — `gh pr merge <#> --squash --delete-branch` (add `--auto` if branch
   protection requires checks to pass first; fall back to `--admin` only if the user has
   said they want to bypass). Report the merge; don't pause for approval.

6. **Tag + GitHub release.** Because the PR is **squash-merged**, the branch commit isn't
   on `main` — first `git checkout main && git pull --ff-only origin main` so HEAD is the
   squash-merge commit, then tag `<tagPrefix><version>` (e.g. `mobile-v2.1.0`) on it, push
   the tag, and `gh release create <tag> --title ... --notes-file
   <appDir>/release-notes/<version>.md --target main` (or `--notes` from the CHANGELOG
   section). See [REFERENCE.md](REFERENCE.md) if `gh pr merge --auto` hasn't landed yet
   (wait for the merge before tagging).

7. **Run the build (always).** Do **not** just hand off — kick off the EAS build for the
   chosen platform from `<appDir>`:
   `npx eas build --platform <platform> --profile production --clear-cache --non-interactive`.
   Run it in the background so the session isn't blocked, and once EAS has queued the
   build(s), **print the build link(s)** for every platform (the `https://expo.dev/…/builds/…`
   URL EAS prints per platform; for `all` that's one per platform). If EAS can't run
   non-interactively (missing credentials), report the failure and the command to finish it.

## Notes

- Defaults target this monorepo: `appDir = apps/mobile`, tag prefix `mobile-v`. Override
  with `RELEASE_APP_DIR` / `RELEASE_TAG_PREFIX` env vars for another app.
- `eas.json` here uses `appVersionSource: "remote"`, so EAS owns the store version at
  build time — the local bump is for the repo/changelog. Flag this if it matters.
- Re-running for an **already-shipped** version is unsafe — steer to a patch instead.
  See [REFERENCE.md](REFERENCE.md).
