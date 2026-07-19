---
name: google-play-review-check
description: Acts as a Google Play reviewer — audits an Android app against the Google Play Developer Program Policies and returns a pass/fail report with the specific policy names at risk and concrete fixes. Use this whenever the user wants to pre-check, pre-flight, audit, or "review like Google would" an Android/Play app before submitting to the Play Console, whenever they mention Google Play rejection, app suspension/removal, policy compliance, closed/open testing review, Data safety form review, permissions declaration, target API level, or worry about why an app might get rejected — even if they just paste a store listing, screenshots, the AndroidManifest, Data safety answers, or an app bundle and ask "will this get approved?"
---

# Google Play Review Check

Play the role of a Google Play policy reviewer. Take whatever the user can provide
about their Android app, walk it against the Google Play Developer Program Policies,
and produce a verdict for each relevant policy plus a concrete fix — the same shape of
feedback Google sends in a rejection or policy-violation email, but *before* they submit
so they can fix it first.

You are not Google and can't guarantee an outcome. Be clear that this is a best-effort
pre-flight audit that reduces rejection/suspension risk; the real reviewer (and Google's
automated scanning) makes the final call.

## What you can review (any subset)

The more inputs, the more thorough the audit. Ask for what's missing but never block —
review what you have and mark unknown areas explicitly.

- **Store listing / metadata**: app title, short & full description, category, screenshots, feature graphic, promo video, contact email, privacy policy URL, "What's new" release notes, content rating (IARC) answers.
- **Privacy & data**: privacy policy URL/text, the **Data safety** form answers (collected/shared data types, purposes, encryption, deletion), permissions requested, third-party SDKs, account-deletion path (in-app **and** the required web URL).
- **Functional description**: what the app does, business model, monetization, login flow, whether a working demo account / test credentials exist for the reviewer.
- **Source code / project (`AndroidManifest.xml`, Gradle, JS/Kotlin/Java)**: scan for **restricted/sensitive permissions** (SMS, Call Log, `MANAGE_EXTERNAL_STORAGE`, `QUERY_ALL_PACKAGES`, background location), **foreground-service types** (Android 14+), **target API level** (`targetSdkVersion`), Play Billing vs. non-Play payment flows, ads SDKs, deceptive/undisclosed behavior, and **permission-request flows** (custom pre-permission dialogs with a decline path — see the mechanical sweep below).
- **Screenshots / built UI**: check against store-listing + ads + minimum-functionality rules (screenshots show real in-app use, no misleading imagery, ads dismissible and non-deceptive, etc.).
- **Play Console data (optional, automated)**: if the user has a Google Play Developer API service account, `scripts/fetch_play_metadata.py` can pull the live store listing + track/release info via the `androidpublisher` API. See "Pulling data from the Play Console" below.

## Process

1. **Intake.** Establish app type, what it does, its business model, target audience (is it in the **Families / Designed for Families** program?), and which inputs the user provided. If they only pasted a description, that's fine — review it and flag that a code/manifest/Data-safety pass would catch more.

2. **Scope the policies.** Read `references/policies.md` — the condensed, review-oriented map of every policy group with violation criteria. Determine which apply. An app with no ads skips most of Ads; a kids app pulls in **Families**; an app that handles SMS pulls in the **SMS/Call Log** restricted-permissions rule; a UGC/social app pulls in **User Generated Content**; a finance/loan app pulls in **Financial Services**. When the app touches a high-risk area (permissions, privacy/Data-safety, payments, financial services, health, gambling, kids/Families, VPN, AI-generated content, News, medical/COVID), re-fetch the live policy page to confirm current wording before ruling — these change and carry the heaviest enforcement (app removal or account termination, not just a rejected update).

3. **Audit each applicable policy.** For every relevant policy produce: policy name (+ subsection), a verdict (**Pass** / **At risk** / **Likely rejection** / **Needs info**), the evidence that drove it, and a concrete fix. Prioritize the high-frequency enforcement reasons listed at the end of `references/policies.md`. Don't invent violations; if you can't determine something from the inputs, mark it **Needs info** and say what to provide.

4. **Run the mechanical-pattern sweep (when source / manifest is available).** Beyond reasoning about policies, there is a set of **objective, detectable patterns Google's own automated scanning and the Play Console pre-launch/release checks flag** — these produce the most predictable rejections and app suspensions, so check them explicitly and default them to **Likely rejection** (not "At risk") when the pattern is present. Grep the project/manifest and trace each hit:

   - **Restricted permissions without a granted declaration (Privacy / Permissions) — highest-signal.** Grep `AndroidManifest.xml` for `SEND_SMS`/`READ_SMS`/`RECEIVE_SMS`/`READ_CALL_LOG`/`WRITE_CALL_LOG`/`PROCESS_OUTGOING_CALLS`. These are gated: the app must be the user-selected **default SMS/Phone/Assistant handler** and use them for documented **core** functionality, or Google removes the app. Any use for a non-core reason (analytics, marketing, "convenience") → **Likely rejection**. Same for `MANAGE_EXTERNAL_STORAGE` (All-files access — needs an eligible use case + declaration), `QUERY_ALL_PACKAGES` (needs an approved use case), and `ACCESS_BACKGROUND_LOCATION` (needs a Permissions Declaration + prominent disclosure + persistent in-use justification). Each of these requires a **Permissions Declaration Form** approval before the release can publish — flag a missing/weak justification as a blocker.
   - **Background location (Location / Permissions).** If `ACCESS_BACKGROUND_LOCATION` is declared, require: a core feature that genuinely needs it, a **prominent in-app disclosure** shown *before* the runtime prompt, and consistency with the Data safety declaration. Background location used only for a foreground feature → **Likely rejection** (request only foreground/`WHILE_IN_USE`).
   - **Foreground service types (Android 14+, `targetSdkVersion ≥ 34`).** Every `<service android:foregroundServiceType=…>` must map to a declared, appropriate type **and** the matching `FOREGROUND_SERVICE_*` permission, and the use case must fit that type. Missing/mismatched type → the release is blocked. Flag it.
   - **Target API level (Spam / Minimum Functionality → technical requirement).** Read `targetSdkVersion`/`targetSdk`. New apps and updates must target a recent Android API level (the requirement moves ~yearly, roughly "latest major Android minus one"). A `targetSdkVersion` below the current Play minimum → the app **cannot be submitted/updated** → treat as a blocker and tell the user the current required level.
   - **Account deletion (User Data).** If the app lets users **create an account**, Google requires **both** an **in-app** deletion path **and** a **web deletion URL** entered in the Data safety form (users must be able to request deletion without reinstalling). Grep for an in-app delete-account path and confirm the web URL exists. Missing either → **Likely rejection**.
   - **Data safety accuracy (Privacy / User Data).** Cross-check the Data safety answers against the actual permissions + SDKs. If the manifest/SDKs collect or share data (ads, analytics, crash, location) that the Data safety form omits — or the form says "no data shared" while an ads/attribution SDK is present — that mismatch is a top enforcement trigger → **Likely rejection**. A missing/placeholder **privacy policy URL** (required whenever any personal/sensitive data or sensitive permission is involved, and always for Families) → blocker.
   - **Permission priming / pre-permission dialogs (Deceptive Behavior / User Data).** Find every runtime permission request (`ActivityCompat.requestPermissions`, `registerForActivityResult(RequestPermission…)`, Expo `request*PermissionsAsync`, `react-native-permissions` `request()`). Trace **backwards**: if a custom `Dialog`/`Modal`/bottom-sheet gates it, Google still expects the rationale to lead to the OS prompt and forbids **deceptive** framing (pressuring, or implying the app breaks without a non-core permission). A pre-prompt gate that misrepresents why the permission is needed, or nags/blocks core use to coerce a grant → **At risk → Likely rejection**. (Play is less mechanically strict here than Apple's 5.1.1(iv), but deceptive/coercive priming is still a Deceptive Behavior violation — never score a priming modal as a compliance *strength*.)
   - **Payments (Monetization).** Grep for non-Play payment flows for **digital** goods/subscriptions (Stripe/PayPal/crypto/external checkout links) — in-app digital purchases must use **Google Play Billing** (narrow exceptions: physical goods, and the specific external-offer/alt-billing programs). Hardcoded external-payment URLs for digital content → **Likely rejection**.
   - **Ads (Monetization / Ads).** Deceptive or disruptive ads (full-screen/interstitial ads that appear unexpectedly or aren't closable, ads that impersonate the OS/system UI or the app's own UI, ads outside the app), or ads that don't respect the content rating / Families requirements → **Likely rejection**.
   - **Deceptive behavior & misrepresentation.** Undisclosed functionality, a listing that doesn't match the app, fake system warnings, or an app that "does nothing"/crashes on launch → **Likely rejection**.

   Ground every finding in a real `file:line` (or manifest entry). Absence of a pattern is a Pass for that pattern; presence is a finding — don't hand-wave either direction.

5. **Verify before finalizing.** Re-read the findings against the actual inputs to avoid false positives (don't flag "no privacy policy" if one was provided) and false negatives (a description mentioning "unlock premium" implies in-app purchases → check Monetization + Data safety). Confirm each cited policy name matches its real title. For code audits, ground every finding in a real file/manifest line, not a guess.

6. **Write the report** using `assets/report_template.md`. Deliver it as a Markdown file in the outputs folder and present it to the user.

## Verdict scale

- **Pass** — nothing in the inputs suggests a problem here.
- **At risk** — plausibly non-compliant or a common reviewer flag; explain the risk and the safer path.
- **Likely rejection** — clearly conflicts with a policy as written; treat as a blocker. **Objective, detectable patterns from the mechanical sweep (step 4) belong here, not in "At risk," whenever the pattern is present** — Google's automated scanning catches them reliably, so a hedge undersells the risk. Distinguish a **rejected update** (fixable, resubmit) from an **app-removal / account-strike** risk (restricted permissions, malware/unwanted-software, deceptive behavior, Families violations) and say which it is.
- **Needs info** — can't judge from what was provided; state exactly what to supply.

**Calibrate toward the reviewer, not the developer.** This audit's value is catching a rejection or suspension *before* it happens — a Play strike can escalate to account termination, so under-flagging is costly. When a pattern matches a known-enforced policy, rule it a blocker and let the developer decide it's a false alarm — an over-flag costs minutes, an under-flag can cost the account. Reserve "At risk" for genuinely judgment-dependent calls; use "Likely rejection" for anything that matches an enforced policy as written. Never label a restricted-permission-without-declaration, missing account-deletion (in-app + web), a Data-safety mismatch, or a below-minimum `targetSdkVersion` as merely "At risk."

Lead the report with a short overall verdict (Ready / Fix-before-submit / Not ready)
and a count of blockers vs. risks, then the per-policy findings grouped by policy area,
then a prioritized fix checklist.

## Pulling data from the Play Console (optional)

There is no Google Play connector, so live data requires the user's own credentials. Only
do this if the user wants it and provides a **Google Play Developer API service account**
JSON key (Play Console → Setup → API access → linked Google Cloud project → service account
with the `androidpublisher` scope, granted app access). Otherwise review pasted inputs.

`scripts/fetch_play_metadata.py` uses that key to fetch the app's **store listing** (title,
descriptions, category) and **track/release** info via the `androidpublisher` API. It signs
a short-lived JWT locally; the key never leaves the sandbox. Run it in the workspace, e.g.:

```
pip install google-auth requests --break-system-packages
python scripts/fetch_play_metadata.py \
  --service-account service_account.json \
  --package com.example.app \
  --out play_metadata.json
```

Then review `play_metadata.json` the same way you'd review pasted metadata. **Note:** the API
does **not** expose the Data safety form, content-rating answers, or permissions declarations —
those still have to be pasted/screenshotted. If the key is missing/invalid, fall back to asking
the user to paste the listing.

## Notes on judgment

- Policies are principles enforced by both automated scanning and human review — reason about *why* a rule exists (usually user safety, privacy, trust, or a fair marketplace) and whether the app honors that spirit, not just the letter.
- Play enforcement is graduated: a bad update is often just **rejected** (fix and resubmit), but restricted-permission misuse, malware/unwanted-software, repeated deceptive behavior, and Families violations can **remove the app or terminate the developer account**. Flag which tier a finding sits in.
- Cite policy names so the user can look them up in the Policy Center and, if they disagree with an enforcement later, appeal with specifics.
