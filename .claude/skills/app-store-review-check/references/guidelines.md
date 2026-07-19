# App Store Review Guidelines — Reviewer Reference

This is a condensed, review-oriented map of Apple's App Store Review Guidelines
(source: https://developer.apple.com/app-store/review/guidelines/). Each entry
gives the guideline number, what a reviewer checks, and the common ways apps get
**rejected** against it. Guidelines marked **[NR]** below are also enforced under
Notarization for iOS/iPadOS apps distributed outside the App Store.

Guidelines change. When a submission touches a nuanced or high-risk area (payments,
privacy, crypto, gambling, health, kids), re-fetch the live page to confirm the
current wording before finalizing a verdict.

## How to use this file

Walk every relevant subsection. For each finding, record:
- Guideline number + title
- Verdict: **Pass**, **At risk**, or **Likely rejection**
- Evidence (what in the app/metadata triggered it)
- Fix (concrete change that resolves it)

Not every guideline applies to every app. Skip cleanly and say why an area is N/A
(e.g. "No IAP, so 3.1 does not apply").

---

## Table of contents
- [1. Safety](#1-safety)
- [2. Performance](#2-performance)
- [3. Business](#3-business)
- [4. Design](#4-design)
- [5. Legal](#5-legal)
- [Highest-frequency rejection reasons](#highest-frequency-real-world-rejection-reasons)

---

## 1. Safety

**1.1 Objectionable Content** — No offensive, insensitive, upsetting, or "creepy" content.
- 1.1.1 Defamatory/discriminatory/mean-spirited content targeting protected groups. (Professional satirists generally exempt.)
- 1.1.2 Realistic depictions of people/animals being killed, maimed, tortured, abused; content encouraging violence. Game "enemies" can't solely target a real race/culture/government/entity.
- 1.1.3 Encouraging illegal/reckless weapon use or facilitating firearm/ammo purchase.
- 1.1.4 Overtly sexual/pornographic material; hookup apps facilitating prostitution/trafficking.
- 1.1.5 Inflammatory or misleading religious commentary.
- 1.1.6 **[NR]** False info/features (fake location trackers, prank call/SMS apps). "For entertainment purposes" does not save it.
- 1.1.7 Profiting from recent tragedies (violent conflict, terror attacks, epidemics).

**1.2 User-Generated Content** — Apps with UGC or social networking **must** include: (a) a filter for objectionable material, (b) a report mechanism with timely response, (c) the ability to block abusive users, (d) published developer contact info. Apps used primarily for porn, random/anonymous chat, objectification ("hot-or-not"), threats, or bullying are removed.
- 1.2.1 Creator content apps must let users flag content exceeding the age rating and gate underage access via verified/declared age.

**1.3 Kids Category** — No out-links, purchasing, or distractions outside a parental gate. No third-party analytics or advertising (narrow exceptions). Must comply with COPPA/GDPR-K and not send PII/device data to third parties.

**1.4 Physical Harm [NR]**
- 1.4.1 Medical apps with inaccurate data get scrutiny; can't claim x-ray/BP/glucose/blood-oxygen from device sensors alone; must advise consulting a doctor.
- 1.4.2 Drug-dosage calculators must come from a manufacturer/hospital/university/insurer/pharmacy or be FDA-cleared.
- 1.4.3 No encouraging tobacco/vape/illegal drugs/excess alcohol; no facilitating controlled-substance sales (except licensed pharmacies / legal cannabis dispensaries).
- 1.4.4 DUI checkpoints only from law enforcement; never encourage drunk/reckless driving.
- 1.4.5 No urging users into physically risky challenges/bets.

**1.5 Developer Information [NR]** — App and Support URL must include an easy way to contact the developer; contact info must be accurate.

**1.6 Data Security [NR]** — Implement appropriate security to protect user info from unauthorized use/disclosure/access.

**1.7 Reporting Criminal Activity** — Crime-reporting apps must involve local law enforcement and only in regions where that's active.

---

## 2. Performance

**2.1 App Completeness**
- (a) **[NR]** Submissions must be final. No placeholder text, dead URLs, empty sites. Tested on-device, no crashes/obvious bugs. Provide a **working demo account or built-in demo mode** if there's a login, and turn the backend on. **This is one of the most common rejection reasons.**
- (b) IAPs must be complete, current, visible, and functional to the reviewer; explain missing ones in review notes.

**2.2 Beta Testing** — Demos/betas/trials belong on TestFlight, not the App Store.

**2.3 Accurate Metadata [NR]** — Name, description, screenshots, previews, and privacy info must reflect the real core experience.
- 2.3.1 **[NR]** No hidden/dormant/undocumented features. Describe all new features specifically in Notes for Review (generic descriptions rejected). No misleading marketing (e.g. fake virus scanners), no false pricing.
- 2.3.2 If IAP exists, description/screenshots/previews must indicate what needs additional purchase.
- 2.3.3 Screenshots must show the app in use — not just title art, login, or splash screen.
- 2.3.4 Previews may only use video screen captures of the app itself.
- 2.3.5 **[NR]** Choose the most appropriate category.
- 2.3.6 **[NR]** Answer age-rating questions honestly.
- 2.3.7 **[NR]** Unique name (≤30 chars); don't stuff keywords with trademarks/competitor names/prices/irrelevant terms.
- 2.3.8 **[NR]** Metadata (icons/screenshots/previews) must be 4+ appropriate even if the app is rated higher. "For Kids/Children" reserved for Kids Category.
- 2.3.9 Secure rights to all materials; use fictional account data in screenshots.
- 2.3.10 Focus on Apple platforms; don't show other platforms' names/icons or irrelevant info.
- 2.3.11 Pre-order apps must ship substantially as advertised.
- 2.3.12 "What's New" must describe significant changes (bug-fix boilerplate OK for minor updates).
- 2.3.13 In-app events must be accurate, within an ASC event type, and deep-link correctly.

**2.4 Hardware Compatibility**
- 2.4.1 iPhone apps should run on iPad where possible.
- 2.4.2 **[NR]** Use power efficiently; no rapid battery drain, excessive heat, or unrelated background processes (e.g. crypto mining, including via ads).
- 2.4.3 Apple TV apps must work with Siri remote / standard controllers.
- 2.4.4 **[NR]** Don't require device restart or unrelated system-setting changes (e.g. "turn off Wi-Fi").
- 2.4.5 Mac App Store extras: sandboxing, Xcode packaging, no auto-launch without consent, no root escalation, no self-updating outside MAS, etc.

**2.5 Software Requirements**
- 2.5.1 **[NR]** **Public APIs only**; must run on the currently shipping OS. Use frameworks for intended purposes (HealthKit for health, HomeKit for home automation). **Private API usage is an automatic rejection.**
- 2.5.2 **[NR]** Self-contained bundle; no downloading/executing code that changes features (narrow educational-code exception).
- 2.5.3 **[NR]** No viruses/malware/disruptive code.
- 2.5.4 **[NR]** Background modes only for intended purposes (VoIP, audio, location, task completion, notifications).
- 2.5.5 Must work on IPv6-only networks.
- 2.5.6 **[NR]** Web-browsing apps must use WebKit + WebKit JS (unless granted an alternative-engine entitlement).
- 2.5.8 No alternate desktop/home-screen environments.
- 2.5.9 **[NR]** Don't alter/disable standard switches or native UI (Volume, Ring/Silent), don't block expected out-links.
- 2.5.11 **[NR]** SiriKit/Shortcuts: only register intents you can handle; relevant vocabulary; resolve directly with no injected ads.
- 2.5.12 **[NR]** CallKit/SMS-fraud extensions block only confirmed spam; disclose criteria; don't reuse data for tracking/profiling.
- 2.5.13 **[NR]** Facial recognition for auth must use LocalAuthentication (not ARKit); alternate method for under-13.
- 2.5.14 **[NR]** Explicit consent + clear indicator when recording camera/mic/screen/user input.
- 2.5.15 File pickers must include Files app and iCloud documents.
- 2.5.16 **[NR]** Widgets/extensions/notifications must relate to the app. App Clip features must be in the main binary; App Clips can't contain ads.
- 2.5.18 **[NR]** Ads only in the main app binary (not extensions/widgets/notifications/keyboards/watchOS). Ads must fit the age rating, be dismissible, be clearly labeled, and be reportable; no behavioral targeting on sensitive/kids/health/school data.

---

## 3. Business

**3.1 Payments**
- 3.1.1 **In-App Purchase:** Unlocking features/content/subscriptions/currency **must** use IAP — not license keys, QR/AR markers, crypto, etc. Loot boxes must disclose odds. Digital gift cards redeemable for digital goods use IAP. NFT: may sell NFT services via IAP; owning an NFT can't unlock in-app features; browsing others' NFT collections can't link to non-IAP purchase (except US storefront).
- 3.1.1(a) **Link to Other Purchase Methods:** Requires StoreKit External Purchase Link entitlement (not needed on US storefront). Outside allowed storefronts/US, **no** buttons/links/CTAs to non-IAP purchasing.
- 3.1.2 **Subscriptions:** Must provide ongoing value; ≥7-day period; available across the user's devices. Don't strip functionality existing users already paid for. Scam/bait-and-switch subscriptions removed.
- 3.1.2(c) **Subscription Info:** Clearly describe what the user gets for the price before subscribing.
- 3.1.3 **Other Purchase Methods** (may bypass IAP; can't steer to non-IAP inside the app except US storefront):
  - (a) Reader apps (magazines, news, books, audio, music, video).
  - (b) Multiplatform services (content bought elsewhere, if also an IAP).
  - (c) Enterprise services sold to organizations.
  - (d) Person-to-person real-time services (1:1 tutoring, consult, tours). One-to-many must use IAP.
  - (e) Physical goods/services consumed outside the app (use Apple Pay / card).
  - (f) Free standalone companion to a paid web tool.
  - (g) Advertising-management apps.
- 3.1.4 Hardware-specific content may unlock without IAP in limited cases.
- 3.1.5 Crypto: wallets require org enrollment; no on-device mining; exchanges need licensing; no currency for completing tasks.

**3.2 Other Business Model Issues**
- 3.2.1 Acceptable: promoting your own apps (not a bare catalog); curated third-party app collections with editorial content; expiring rental content; Wallet passes for payments/offers/ID; free insurance apps; approved-nonprofit fundraising with Apple Pay; optional person-to-person monetary gifts (100% to receiver); licensed financial-trading apps.
- 3.2.2 Unacceptable: App-Store-like storefronts of third-party apps; inflating ad impressions / apps built mainly to show ads; non-approved charity fundraising inside the app; arbitrarily restricting who can use the app; manipulating rank/visibility on other services; binary-options trading; unlicensed CFD/FOREX; personal-loan apps with APR > 36% or repayment ≤ 60 days; forcing users to rate/review/download other apps to unlock functionality.

---

## 4. Design

**4.1 Copycats** — Original ideas only; no cloning another app's name/UI; (b) **[NR]** no impersonating other apps/services; (c) no using another developer's icon/brand/name without approval.

**4.2 Minimum Functionality** — Must be more than a repackaged website; must offer lasting value/utility. Not just marketing material, web clippings, or link collections (4.2.2). Must work without installing another app (4.2.3(i)); disclose large initial downloads (4.2.3(ii)). 4.2.6: apps from commercialized templates/generators are rejected unless submitted directly by the content provider (or via an aggregated "picker" model). 4.2.7: remote-desktop clients have strict rules (user-owned host, LAN, no store-like UI).

**4.3 Spam** — (a) **[NR]** No duplicate Bundle IDs of the same app (use IAP for variants); (b) don't pile onto saturated categories (fart/flashlight/fortune-telling/etc.) without a unique high-quality experience.

**4.4 Extensions [NR]** — Must comply with extension programming guides; disclose extensions in marketing text; extensions can't include marketing/ads/IAP.
- 4.4.1 Keyboard extensions: must provide typed input, next-keyboard switch, work without full network/access; collect activity only to enhance the keyboard; must not launch other apps (except Settings) or repurpose keys.
- 4.4.2 Safari extensions: run on current Safari; don't interfere with system/Safari UI; no malicious/misleading code; request minimal site access.

**4.5 Apple Sites and Services [NR]**
- 4.5.1 No scraping Apple sites or building rankings from them.
- 4.5.2 Apple Music/MusicKit: user-initiated playback with standard controls; don't monetize access; don't download/upload/share MusicKit files; disclose access to Apple Music user data.
- 4.5.3 Don't spam/phish via Apple services (Game Center, Push).
- 4.5.4 Push Notifications not required to function; no marketing pushes without explicit opt-in and an opt-out.
- 4.5.6 Apple emoji only inside the app/metadata (not on other platforms, not embedded in the binary).

**4.7 Mini apps / mini games / streaming games / chatbots / plug-ins / emulators [NR]** — Developer is responsible for all such software: it must follow privacy (5.1), include UGC moderation (filter/report/block), and use IAP (3.1) for digital goods. Can't expose native APIs without Apple permission; can't share data/permissions without explicit per-instance consent; must provide an index with universal links; must age-gate content exceeding the app rating.

**4.8 Login Services [NR]** — If the app uses a third-party/social login (Facebook, Google, etc.) to set up the primary account, it must **also** offer an equivalent login that (a) limits collection to name+email, (b) lets users keep email private, (c) doesn't collect app interactions for ads without consent. (Sign in with Apple satisfies this.) Exceptions: your own account system only, alt marketplaces, education/enterprise, government ID, or client-for-a-specific-service apps.

**4.9 Apple Pay [NR]** — Present all material purchase info before sale; correct Apple Pay branding; recurring payments must disclose term length, what's provided, actual charges, and how to cancel.

**4.10 Monetizing Built-In Capabilities [NR]** — Don't monetize hardware/OS capabilities (Push, camera, gyroscope) or Apple services (Apple Music access, iCloud storage, Screen Time APIs).

---

## 5. Legal

**5.1 Privacy [NR]**
- 5.1.1 **Data Collection and Storage**
  - (i) Privacy policy required (linked in ASC metadata and inside the app), stating what's collected, how, all uses; third-party protection parity; retention/deletion and how to revoke consent.
  - (ii) Consent required for collecting user/usage data (even if anonymous). Paid functionality can't be gated on granting data access. Provide an easy way to withdraw consent. Purpose strings must fully describe the use.
  - (iii) Data minimization: request only data relevant to core functionality; prefer out-of-process pickers/share sheets over full Photos/Contacts access.
  - (iv) Respect permission settings; don't trick/force consent. Provide alternatives when consent is declined. **Pre-permission "priming" screens are heavily enforced and a top real-world rejection** — see the dedicated rule below.

    > **5.1.1(iv) — Pre-permission priming / "purpose" dialogs (READ THIS; commonly rejected).**
    > When an app shows its **own** custom message *before* triggering a system permission prompt (camera, photos, location, mic, contacts, notifications, etc.), Apple requires: **after the custom message, the user must always proceed to the system permission prompt.** The exact rejection wording Apple uses:
    > *"A custom message appears before the permission request, and the user can close the message and delay the permission request with the Cancel button. The user should always proceed to the permission request after the message."*
    >
    > **Reject (Likely rejection) when a custom pre-permission dialog/modal/action-sheet offers ANY path that dismisses it without reaching the system prompt** — a `Cancel`, `Not now`, `Maybe later`, `Deny`, `No thanks`, backdrop-tap, swipe-to-dismiss, or hardware-back that returns the user to the app instead of showing the OS prompt. The custom screen may only have affirmative buttons that each lead straight to the system prompt.
    > - This applies **even when the pre-permission copy is content-policy text** (e.g. "Use a photo you have rights to; no nudity…") rather than a permission rationale — if that message gates the permission and has a Cancel, it trips 5.1.1(iv). Show content/UGC guidelines **after** access is granted, or as inline non-blocking helper text, not as a blocking dialog with a decline path in front of the OS prompt.
    > - A **source picker** ("Take Photo / Choose from Library / Cancel") is acceptable *only* if selecting a source goes straight to the system prompt and the sheet carries **no** pre-permission rationale/priming copy. Bundling rationale text into that sheet turns it into a priming screen with a decline path → reject.
    > - A **priming rationale modal** (icon + explanation + "Enable"/"Continue" **and** a "Not now"/"Cancel" secondary) is the classic violation. Fix: either drop the custom modal and call the permission API directly (the OS prompt is itself the ask), or keep the modal but make **every** button lead to the system prompt (no secondary/dismiss). Re-prompting after a hard denial must route to Settings, not re-show a custom dialog that swallows the request.
    > - **How to audit in code:** find every native permission call (`request*PermissionsAsync`, `AVCaptureDevice.requestAccess`, `CLLocationManager.requestWhenInUse…`, `PHPhotoLibrary.requestAuthorization`, `UNUserNotificationCenter.requestAuthorization`, `Permissions.request`, etc.). For each, trace **backwards**: is it reached only after a custom `Alert`/`Modal`/action-sheet? Does that gate expose a Cancel/dismiss/secondary/backdrop path? If yes → **Likely rejection** under 5.1.1(iv). A priming screen is a **risk, never a compliance plus** — do not score it as a strength.
  - (v) Account Sign-In: no forced login if the app lacks significant account features. If account creation is offered, **account deletion must be offered in-app**. Don't require personal info unless core or legally required.
  - (vi) No surreptitiously discovering passwords/private data.
  - (viii) No compiling personal info from sources other than directly from the user (even public databases).
  - (ix) Highly regulated fields (banking, health, gambling, cannabis, air travel, crypto exchange) must be submitted by the legal entity providing the service, not an individual.
- 5.1.2 **Data Use and Sharing**
  - (i) No using/sharing personal data without permission; disclose third-party (incl. third-party AI) sharing and get explicit consent. **App Tracking Transparency**: explicit permission via ATT API required to track. Can't require enabling notifications/location/tracking to use the app or get compensation.
  - (ii) No repurposing data beyond the original consented purpose.
  - (iii) No building/reconstructing user profiles from "anonymized"/aggregated data.
  - (iv) Don't use Contacts/Photos to build a contact database or harvest installed-apps lists for analytics/ads.
  - (vi) Data from HomeKit/HealthKit/Clinical Health Records/ClassKit/ARKit/depth-face-mapping can't be used for marketing/ads/data mining.
- 5.1.3 **Health & Health Research** — Health/fitness/medical data can't be used for ads/marketing/data mining; no false HealthKit writes; no health PII in iCloud; human-subject research needs informed consent and independent ethics-board approval.
- 5.1.4 **Kids** — Extra care under COPPA/GDPR; kid-primary apps shouldn't include third-party analytics/ads; privacy policy required; "For Kids/Children" reserved for Kids Category.
- 5.1.5 **Location Services** — Use only when directly relevant; notify and get consent; not for emergency services / autonomous vehicle control (small toys/drones excepted).

**5.2 Intellectual Property**
- 5.2.1 No protected third-party trademarks/copyright/patents without permission; app submitted by the rights owner/licensee.
- 5.2.2 Using/monetizing a third-party service requires permission under its ToU.
- 5.2.3 No facilitating illegal file sharing or downloading media from third-party sources (YouTube, SoundCloud, etc.) without authorization.
- 5.2.4 No implying Apple endorsement.
- 5.2.5 **[NR]** No confusing similarity to Apple products/interfaces; no Apple emoji in keyboards/stickers; no unauthorized iTunes/Apple Music previews for entertainment.

**5.3 Gaming, Gambling, and Lotteries**
- 5.3.1 Sweepstakes/contests must be sponsored by the developer.
- 5.3.2 Official rules must appear in-app and state Apple isn't a sponsor.
- 5.3.3 No IAP to buy credit/currency for real-money gaming.
- 5.3.4 Real-money gaming/lotteries need licensing, geo-restriction, and must be free; no card counters.

**5.4 VPN Apps [NR]** — Must use NEVPNManager API; org enrollment only; declare data collection; no selling/using/disclosing data to third parties; provide license info where required.

**5.5 Mobile Device Management [NR]** — MDM requires Apple approval; limited to enterprises/education/government (and limited parental-control/security cases); declare data collection; no selling/disclosing data.

**5.6 Developer Code of Conduct [NR]** — Treat everyone with respect; no manipulative/misleading behavior; no ripping off users. 5.6.1 respectful review responses + Apple's rating API only; 5.6.2 accurate developer identity; 5.6.3 no discovery fraud (charts/search/reviews/referrals manipulation); 5.6.4 maintain app quality (excessive complaints/refunds are a signal).

---

## Highest-frequency real-world rejection reasons

When triaging, check these first — they account for the bulk of rejections:

1. **2.1 Completeness** — crashes, bugs, broken links, no working demo account/login for the reviewer, backend off, IAP not functional.
2. **2.3.x Accurate Metadata** — screenshots that don't show the app in use, undocumented features, misleading description/keywords, undisclosed IAP.
3. **5.1.1 Privacy** — missing/invalid privacy policy link, vague purpose strings, no in-app account deletion when account creation exists.
4. **5.1.1(iv) Permission priming** — a custom pre-permission dialog with a `Cancel`/`Not now`/dismiss path that lets the user avoid the system prompt (must always proceed to the OS prompt after the message). Auto-detected and frequently rejected; treat any pre-prompt gate with a decline path as a blocker.
5. **5.1.2 ATT** — tracking without an App Tracking Transparency prompt; privacy "nutrition label" mismatch with actual behavior.
6. **3.1.1 IAP** — unlocking digital content by a method other than IAP, or steering users to external payment where not permitted.
7. **4.2 Minimum Functionality** — thin apps, repackaged websites, template-generated apps.
8. **4.3 Spam** — duplicate/near-duplicate apps, saturated low-value categories.
9. **2.5.1 Private APIs** — use of non-public APIs or frameworks used outside their intended purpose.
10. **4.8 Login** — social login offered without an equivalent privacy-preserving option (e.g. Sign in with Apple).
11. **1.5 / 5.1.1(i)** — no working support/contact path.
