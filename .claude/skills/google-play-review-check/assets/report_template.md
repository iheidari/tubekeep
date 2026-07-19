# Google Play Review Pre-Flight — [App Name]

**Reviewed:** [date] · **Package:** [com.example.app] · **Target audience:** [general / Families] · **Inputs reviewed:** [listing / Data safety / screenshots / manifest+code / Play API]

> This is a best-effort audit against the Google Play Developer Program Policies, not an official Google decision. Play's automated scanning and the review team make the final call.

## Overall verdict

**[ Ready to submit | Fix before submit | Not ready ]**

- 🔴 Blockers (Likely rejection / removal): [n]
- 🟠 Risks (At risk): [n]
- ⚪ Needs info: [n]

One-paragraph summary of the biggest issues, whether the app is close, and — critically —
whether any finding is **account-strike / app-removal** tier (not just a rejected update).

## Findings by policy area

For each relevant policy. Omit areas that don't apply (state which and why).
Note the enforcement tier (rejected update vs. app removal / account strike) in the Evidence column.

### 1. Restricted Content
| Policy | Verdict | Evidence (+ tier) | Fix |
|---|---|---|---|
| e.g. User Generated Content | 🔴/🟠/🟢/⚪ | what triggered it | concrete change |

### 2. Impersonation & Intellectual Property
| Policy | Verdict | Evidence (+ tier) | Fix |
|---|---|---|---|

### 3. Privacy, Deception & Device Abuse
| Policy | Verdict | Evidence (+ tier) | Fix |
|---|---|---|---|

### 4. Monetization & Ads
| Policy | Verdict | Evidence (+ tier) | Fix |
|---|---|---|---|

### 5. Store Listing & Promotion
| Policy | Verdict | Evidence (+ tier) | Fix |
|---|---|---|---|

### 6. Spam, Functionality & Minimum Quality
| Policy | Verdict | Evidence (+ tier) | Fix |
|---|---|---|---|

### 7. Families / Designed for Families
| Policy | Verdict | Evidence (+ tier) | Fix |
|---|---|---|---|

### 8. Malware & Mobile Unwanted Software
| Policy | Verdict | Evidence (+ tier) | Fix |
|---|---|---|---|

## Mechanical sweep results (manifest / code)

Only when source was available. Cite real `file:line` / manifest entries.

- [ ] Restricted permissions (SMS/Call Log, `MANAGE_EXTERNAL_STORAGE`, `QUERY_ALL_PACKAGES`) — [finding]
- [ ] Background location (`ACCESS_BACKGROUND_LOCATION`) + prominent disclosure — [finding]
- [ ] Foreground-service types (Android 14+) — [finding]
- [ ] `targetSdkVersion` vs. current Play minimum — [finding]
- [ ] Account deletion (in-app + web URL) — [finding]
- [ ] Data safety vs. actual permissions/SDKs — [finding]
- [ ] Payments (Google Play Billing for digital goods) — [finding]
- [ ] Ads (deceptive/disruptive) — [finding]

## Prioritized fix checklist

Ordered by severity — do the account-strike / removal blockers first.

1. [ ] **[Policy]** — [action]
2. [ ] **[Policy]** — [action]

## Not applicable / not assessed

- [Policy area] — N/A because [reason]
- [Policy area] — couldn't assess; provide [input] to check.

## Notes to prepare for the Play Console

Anything that helps the release clear review: demo/test account credentials, an explanation
of restricted-permission use for the Permissions Declaration Form, the prominent-disclosure
copy, the account-deletion web URL, licensing docs (finance/gambling/health), and the
closed-testing plan (≥12 testers / ≥14 days for newer personal accounts).
