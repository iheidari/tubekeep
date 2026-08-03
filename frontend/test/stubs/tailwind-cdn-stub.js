// Stand-in for `https://cdn.tailwindcss.com?plugins=forms,container-queries`,
// served to the browser by the a11y suite instead of the real CDN so the tests
// stay hermetic (no network beyond localhost — see test/a11y/support/hermetic.js).
//
// It deliberately reproduces ONE thing: the forms plugin's `:focus` reset, which
// is the adversary the app's global focus ring has to out-rank. That reset is
// what made the ring invisible on every text input in the app (0XC-111, fixed in
// ad9b90d by prefixing the rule with `:root`), and reproducing it is the whole
// reason this file exists — without it the focus-ring assertions would pass even
// with the fix reverted, i.e. they'd be vacuous. `focus-ring.spec.js` opens with
// a non-vacuity test that proves this rule is actually live and actually wins
// against an unprefixed selector.
//
// Provenance of the rule below:
//   - The declaration is @tailwindcss/forms' base `&:focus` block, verbatim:
//     `outline: 2px solid transparent; outline-offset: 2px` (src/index.js).
//   - The selector form is the flat `[type="..."]:focus` one the Play CDN build
//     ships — specificity (0,2,0), as observed and recorded on 0XC-270. Note the
//     plugin's own npm source now wraps these in `:where()` (specificity (0,1,1),
//     which would NOT have caused the bug); the CDN bundle is the thing the app
//     actually loads, so the CDN's form is what's pinned here.
//
// If the app ever stops loading Tailwind from the CDN, or the CDN's forms build
// changes shape, refresh this file to match what the browser really receives —
// a stale adversary makes the suite weaker without making it red.

// The real CDN script defines a global the page's inline `tailwind.config = {…}`
// block assigns onto. Without it that block throws and the page never boots.
window.tailwind = { config: {} }

const FORMS_PLUGIN_FOCUS_RESET = `
  [type="text"]:focus,
  [type="email"]:focus,
  [type="url"]:focus,
  [type="password"]:focus,
  [type="number"]:focus,
  [type="date"]:focus,
  [type="datetime-local"]:focus,
  [type="month"]:focus,
  [type="search"]:focus,
  [type="tel"]:focus,
  [type="time"]:focus,
  [type="week"]:focus,
  [multiple]:focus,
  textarea:focus,
  select:focus {
    outline: 2px solid transparent;
    outline-offset: 2px;
  }
`

// Injected into <head> so it lands in the same cascade position the real CDN's
// generated stylesheet would — before the page's own inline <style> block, so
// source order alone can't decide the winner and specificity has to.
const style = document.createElement('style')
style.id = 'tailwind-forms-plugin-stub'
style.textContent = FORMS_PLUGIN_FOCUS_RESET
document.head.appendChild(style)
