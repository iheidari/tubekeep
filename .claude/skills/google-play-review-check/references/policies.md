# Google Play Developer Program Policies — Reviewer Reference

This is a condensed, review-oriented map of the Google Play Developer Program Policies
(Policy Center: https://support.google.com/googleplay/android-developer/answer/9858738 ·
content-policy overview: https://play.google/developer-content-policy/). Each entry gives
the policy name, what a reviewer / automated scan checks, and the common ways apps get
**rejected, removed, or the account suspended**.

Play enforcement is graduated: a policy-violating update is often **rejected** (fix and
resubmit), but some violations (restricted-permission misuse, malware/unwanted software,
repeated deception, Families/child-safety, illegal content) lead to **app removal or
developer-account termination**. Each section flags the higher tier where it applies.

Policies change. When a submission touches a nuanced or high-risk area (permissions,
Data safety, payments, financial services, health, gambling, kids/Families, VPN,
AI-generated content, News), re-fetch the live page to confirm current wording.

## How to use this file

Walk every relevant policy. For each finding, record:
- Policy name (+ subsection)
- Verdict: **Pass**, **At risk**, or **Likely rejection**
- Enforcement tier: **rejected update** vs. **app removal / account strike**
- Evidence (what in the app/metadata/manifest triggered it)
- Fix (concrete change that resolves it)

Not every policy applies to every app. Skip cleanly and say why an area is N/A
(e.g. "No ads, so the Ads policy does not apply").

---

## Table of contents
- [1. Restricted Content](#1-restricted-content)
- [2. Impersonation & Intellectual Property](#2-impersonation--intellectual-property)
- [3. Privacy, Deception & Device Abuse](#3-privacy-deception--device-abuse)
- [4. Monetization & Ads](#4-monetization--ads)
- [5. Store Listing & Promotion](#5-store-listing--promotion)
- [6. Spam, Functionality & Minimum Quality](#6-spam-functionality--minimum-quality)
- [7. Families & Designed for Families](#7-families--designed-for-families)
- [8. Malware & Mobile Unwanted Software](#8-malware--mobile-unwanted-software)
- [Highest-frequency enforcement reasons](#highest-frequency-real-world-enforcement-reasons)

---

## 1. Restricted Content

Content that isn't allowed on Play, or is allowed only under conditions.

- **Child Endangerment / CSAE** — Zero tolerance. Any content that sexualizes or endangers minors → **immediate removal + account termination + reporting.** Apps in the child space have extra scrutiny.
- **Inappropriate Content / Sexual Content & Profanity** — No pornography or content whose primary purpose is sexual gratification. Sexual content must be age-appropriate to the rating; gratuitous profanity is restricted.
- **Hate Speech** — No content promoting violence or hatred against groups by protected characteristics (race, ethnicity, religion, disability, age, nationality, veteran status, sexual orientation, gender identity, immigration status).
- **Violence / Graphic Content** — No gratuitous depictions of violence or gore; terrorist content is prohibited; realistic violence must fit the content rating.
- **Sensitive Events** — No capitalizing on or lacking sensitivity toward a sensitive event (natural disaster, atrocity, conflict, health emergency, death).
- **Bullying & Harassment** — No content that threatens, harasses, or bullies.
- **Dangerous Products / Illegal Activities** — No facilitating the sale of explosives, firearms/ammunition/certain accessories, or illegal drugs; no promoting illegal activity.
- **Marijuana** — No apps that facilitate the sale of marijuana or THC products (regardless of local legality) — e.g. in-app ordering/cart, or connecting buyers to a dispensary for delivery.
- **Tobacco & Alcohol** — No facilitating the sale of tobacco; alcohol sale/consumption content must be age-gated.
- **Financial Services** — Personal-loan, lending, crypto, binary options, CFD/FX, gambling-adjacent, and "buy now pay later" apps have specific disclosure + eligibility rules. **Personal-loan apps** must disclose APR, repayment terms, examples, and a policy; short-term/high-APR predatory loans are banned; no access to a borrower's contacts/photos. Crypto exchanges/wallets have regional licensing rules.
- **Real-Money Gambling, Games & Contests** — Only allowed in approved countries, licensed, age-gated, geo-restricted, and free to download; must apply and be approved. Loot boxes / paid random items must disclose odds.
- **Illegal Activities / Facilitating** — No enabling illegal behavior.
- **User Generated Content (UGC)** — Apps hosting UGC **must**: (a) require users to accept terms/an acceptable-use policy before creating content, (b) provide an **in-app reporting/flagging** system for objectionable content **and users**, (c) provide **in-app blocking** of abusive users, (d) **remove or block** offending content/users, and (e) publish a way to contact the developer. Apps whose primary use is objectionable UGC are removed. **AI-generated content (GenAI) apps** must add safeguards against offensive output and in-app reporting.
- **Health Content / Health Misinformation** — No misleading health claims; medical apps have accuracy expectations; no promotion of unapproved treatments; COVID/medical-misinformation rules.
- **News** — News apps must provide sources, headers, and not misrepresent affiliation.
- **Elections / Misrepresentation** — No misleading content undermining civic processes.

---

## 2. Impersonation & Intellectual Property

- **Impersonation** — Don't pretend to be another person, entity, developer, organization, or app; don't imply an affiliation/endorsement you don't have; no fake reviews/testimonials. Icons, titles, and descriptions that mimic another brand → removal.
- **Intellectual Property** — No infringing copyright, trademark, or other IP; no selling/promoting counterfeit goods; no encouraging IP infringement. You must have rights to all content. Google acts on valid takedown/DMCA notices.
- **Use of Others' Brand / "Official" claims** — Don't use another company's logo/name to imply an official app without authorization.

---

## 3. Privacy, Deception & Device Abuse

The densest enforcement area and the most code/manifest-detectable.

- **User Data** — Be transparent about data handling and limit use to disclosed purposes.
  - **Privacy Policy** — Required (in the store listing field **and** within the app) whenever the app handles **personal or sensitive user data** or requests a sensitive permission. Must be comprehensive, accurate, and cover all collected data + third-party sharing. Missing/placeholder/dead URL → **Likely rejection**.
  - **Prominent Disclosure & Consent** — Collection of personal/sensitive data that isn't obviously in-context (especially background location, contacts, SMS, photos) needs an **in-app prominent disclosure + affirmative consent** shown **before** collection begins — separate from the OS runtime prompt and the privacy policy.
  - **Data safety section** — The Play Console Data safety form must **accurately** declare what data is collected/shared, for what purpose, whether it's encrypted in transit, and whether users can request deletion. It must **match** the app's actual behavior (permissions + SDKs). A mismatch (e.g. "no data shared" with an ads/analytics/attribution SDK present, or an undeclared collected type) is a top enforcement trigger → **Likely rejection.**
  - **Account deletion** — If the app lets users **create an account**, you must offer **both** an **in-app** way to delete the account + data **and** a **web URL** (entered in Data safety) to request deletion without reinstalling. Missing either → **Likely rejection.**
  - **Data minimization** — Request only the data/permissions needed for current features; don't sell personal/sensitive data.
- **Permissions & APIs that Access Sensitive Information** — Request only permissions needed for current, disclosed functionality; use them only for that.
  - **SMS & Call Log** (`READ/SEND/RECEIVE_SMS`, `READ/WRITE_CALL_LOG`, `PROCESS_OUTGOING_CALLS`) — Restricted. App must be the user-selected **default SMS/Phone/Assistant handler** and use them for documented **core** functionality; a limited exception set applies. Non-core use (analytics, marketing, backup-for-convenience) → **removal.** Requires an approved **Permissions Declaration**; the release **cannot publish** until it's provided or the permission is removed.
  - **All-files access** (`MANAGE_EXTERNAL_STORAGE`) — Only for apps with an eligible use case (file managers, backup, anti-virus, etc.) with a declaration; otherwise use scoped storage / SAF. Ineligible use → removal.
  - **Package visibility** (`QUERY_ALL_PACKAGES`) — Restricted; needs an approved use case (e.g. it's the app's core purpose to know/interoperate with all apps). Otherwise use targeted `<queries>`.
  - **Background location** (`ACCESS_BACKGROUND_LOCATION`) — Requires a core feature that needs it, a **Permissions Declaration**, a **prominent disclosure**, and Data-safety consistency. Using it for a foreground-only feature → **removal.**
  - **Accessibility API, Notification-listener, Device Admin, VPNService, Usage Access** — Only for their intended purpose; misuse (e.g. Accessibility to run ads or track) → removal.
  - **Exact alarms, full-screen intents, foreground-service types** — Android-14+ declarations must be present, appropriate, and matched to the right permission.
- **Deceptive Behavior** — No misleading users: no false/undisclosed functionality, no fake system/security warnings, no imitating the OS or another app's UI, no changing device settings without consent, no misrepresenting the app in the listing. Metadata must match actual behavior.
- **Device & Network Abuse** — No interfering with the device/other apps/servers/networks; no unauthorized data usage; no click/ad fraud; no unofficial self-updating or downloading executable code that changes the app's primary behavior outside Play (interpreted-code exception applies).
- **Use of SDKs** — Developers are responsible for all bundled SDKs; an SDK that mishandles data or misuses permissions makes the app non-compliant. Use SDK versions that meet Play's data/permission rules.

**Enforcement tier:** most of §3 (restricted permissions, deceptive behavior, device/network abuse, Data-safety falsification) is **app-removal / account-strike**, not just a rejected update.

---

## 4. Monetization & Ads

- **Payments (Google Play Billing)** — Digital goods/content/subscriptions consumed **in the app** must use **Google Play's billing system**. You can't steer users to an external non-Play payment method for in-app digital purchases except under the specific programs (external-offer / alternative-billing / user-choice billing, region-dependent) or narrow exceptions. **Physical** goods/services and P2P payments use other methods (not Play Billing). Bypassing Play Billing for digital goods → **Likely rejection / removal.**
- **Subscriptions** — Disclose price, billing period, renewal terms, free-trial → paid transitions, and cancellation clearly **before** purchase; no misleading/coercive subscription flows; provide the promised ongoing value.
- **Ads** — Ads must not be deceptive or disruptive:
  - No ads that **impersonate** the app UI, a system notification/warning, or the device OS.
  - No **unexpected full-screen/interstitial** ads that interrupt use, or ads shown outside the app / on the lock screen without proper context.
  - Ads must be **closable** without penalty and must not trick the user into clicking.
  - Ads must respect the **content rating** and the app's audience (see Families for stricter kids-ad rules; use a Families-certified ads SDK).
  - Disclose the app uses ads where required; no ad fraud.
- **Content rating (IARC)** — Complete the rating questionnaire accurately; an inaccurate/missing rating → the app can be removed or rated by Google. Rating must match actual content.

---

## 5. Store Listing & Promotion

- **Metadata / Store Listing** — Title, icon, description, screenshots, feature graphic, and video must accurately represent the app; no misleading claims, no keyword stuffing, no unverified performance claims, no irrelevant references to other apps/brands, no misuse of the "Editor's Choice"/Google branding. Title length and formatting limits apply (no emoji spam, no all-caps gimmicks, no "#1"/price/promo in the title).
- **Screenshots & Promo assets** — Must show the actual in-app experience (not just splash/login/marketing art), be appropriate to the rating, and not include misleading device frames or other-platform imagery.
- **User Ratings, Reviews & Installs** — No fake or incentivized ratings/reviews/installs; don't manipulate placement or discovery; don't pressure/bribe users for positive reviews.
- **Promotion / Spam** — No misleading promotion, no promoting off-Play distribution to bypass policy, no chains/referral schemes that spam.

---

## 6. Spam, Functionality & Minimum Quality

- **Minimum Functionality** — The app must install, load, and run on the intended devices without crashing, freezing, or showing only an error/placeholder. It must provide a reasonable degree of utility — not a bare web wrapper, a static page, an empty shell, or a "test" app. Broken core flow → **Likely rejection.**
- **Broken Functionality** — No non-functional or purposeless features, dead buttons, or "coming soon" placeholders in the released build.
- **Repetitive / Copycat Content (Spam)** — No submitting multiple near-identical apps, keyword/text spam, or auto-generated/low-value content; one app per purpose.
- **Store abuse** — No manipulating the store (fake installs, misleading titles) — overlaps with §5.
- **Technical requirements**
  - **Target API level** — New apps and updates must meet Play's **target API level requirement** (`targetSdkVersion`/`targetSdk` at or above the current minimum — this rises ~yearly, roughly the latest major Android version minus one). Below the minimum → **cannot submit/update.** Confirm the current required level from Play's target-API-level page.
  - **App bundle / signing** — New apps must ship as an **Android App Bundle (.aab)**; Play App Signing applies.
  - **64-bit** — Apps with native code must include 64-bit libraries.
  - **Pre-launch report / testing** — For personal developer accounts created recently, Play requires **closed testing with ≥12 testers for ≥14 days** before production access; account for that timeline.

---

## 7. Families & Designed for Families

Applies to any app whose target audience includes children, or that opts into Designed for Families.

- **Target audience & content** — Declare the target age group honestly; content must be appropriate for the declared ages. Apps appealing to both kids and adults must treat users as children where required.
- **Data practices** — Comply with COPPA, GDPR-K, and applicable child-protection law. Neither the app nor its SDKs may collect kids' personal data improperly; a **privacy policy is mandatory**.
- **Ads & monetization for kids** — Must use a **Google Play self-certified Families ads SDK**; no behavioral/interest-based ads to children; ads must be clearly distinguishable and age-appropriate; no disruptive ad formats; no misleading commercial content or pressure to spend.
- **APIs & permissions** — No requesting AAID/ad-ID or sensitive permissions inconsistent with the Families requirements; no using disallowed APIs for children.
- **Enforcement tier:** Families violations are **app-removal** level and can strike the account.

---

## 8. Malware & Mobile Unwanted Software

- **Malware** — No code that endangers users, their data, or devices: trojans, spyware, stalkerware, phishing, backdoors, privilege escalation, hostile downloaders, SMS/toll fraud, ransomware, rooting. Zero tolerance → **removal + account termination.**
- **Mobile Unwanted Software (MUwS)** — No deceptive install/behavior, undisclosed data collection, ad fraud, imitating system UI, or social-engineering. Software must be transparent about what it does.
- **Stalkerware / Surveillance** — Consumer surveillance/spying apps are banned; monitoring apps (parental/enterprise) must not hide, must disclose monitoring with a persistent notification, and must present themselves honestly (no "spy"/"catch a cheater" framing).
- **Anti-abuse / self-updating code** — No downloading and executing code from outside Play that changes the app's behavior (beyond the allowed interpreted-language exception); no evading Google's malware detection.

---

## Highest-frequency real-world enforcement reasons

When triaging, check these first — they account for the bulk of Play rejections and removals:

1. **Data safety mismatch / missing privacy policy** (§3 User Data) — the Data safety form doesn't match the app's real permissions/SDKs, or the privacy policy URL is missing/placeholder/dead. Top rejection reason.
2. **Restricted / sensitive permissions without an approved declaration** (§3 Permissions) — SMS/Call Log without default-handler + core use, `MANAGE_EXTERNAL_STORAGE`, `QUERY_ALL_PACKAGES`, `ACCESS_BACKGROUND_LOCATION` without justification, prominent disclosure, and a Permissions Declaration. App-removal tier.
3. **Missing account deletion** (§3 User Data) — account creation exists but there's no in-app deletion path **and** no web deletion URL in Data safety.
4. **Below-minimum target API level** (§6 Technical) — `targetSdkVersion` under Play's current requirement; the release can't be submitted at all.
5. **Foreground-service type / Android-14 declaration missing or mismatched** (§3/§6) — a `foregroundServiceType` without the right type + permission, or a use case that doesn't fit the type.
6. **Deceptive behavior / metadata mismatch** (§3/§5) — undisclosed functionality, listing doesn't match the app, fake system warnings, imitating the OS/another app.
7. **Payments bypassing Google Play Billing** (§4) — unlocking in-app digital content/subscriptions via an external/non-Play method outside the allowed programs.
8. **Ads: deceptive or disruptive** (§4) — full-screen ads that interrupt use or aren't closable, ads impersonating system UI, non-Families-certified ads in a kids app.
9. **Minimum functionality / broken app** (§6) — crashes on launch, thin web wrapper, placeholder/"coming soon" build.
10. **UGC without moderation** (§1 UGC) — a social/UGC app lacking in-app report, block, and content-removal tooling + acceptable-use acceptance.
11. **Families non-compliance** (§7) — kids-audience app using a non-certified ads SDK, behavioral ads to children, or missing privacy policy.
12. **Impersonation / IP** (§2) — icon/title/description mimicking another brand, or infringing content.
