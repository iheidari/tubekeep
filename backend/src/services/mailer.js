// Tiny mailer wrapper. Sends the magic-link email via the Resend HTTP API when
// RESEND_API_KEY is set; otherwise (dev / tests) it logs the link to the server
// console so the whole login flow is exercisable without any email credentials.
//
// The Resend SDK is required lazily so importing this module never fails when
// the dependency's transitive env expectations aren't met in a bare test run.
const { appUrl } = require('./authService');

// Build the clickable verify URL the user receives. Points at the backend's
// verify route, which sets the session cookie and redirects into the app.
function buildMagicLink(rawToken) {
  return `${appUrl()}/api/auth/verify?token=${encodeURIComponent(rawToken)}`;
}

function renderEmail(link) {
  const subject = 'Your Tubekeep sign-in link';
  const text = `Click to sign in to Tubekeep:\n\n${link}\n\nThis link is single-use and expires in 15 minutes. If you didn't request it, you can ignore this email.`;
  const html = `<p>Click to sign in to Tubekeep:</p><p><a href="${link}">Sign in to Tubekeep</a></p><p>This link is single-use and expires in 15 minutes. If you didn't request it, you can ignore this email.</p>`;
  return { subject, text, html };
}

// Send (or, in dev, log) the magic link to `email`. Never throws to the caller
// for a delivery failure — the request handler responds generically regardless,
// so a mail outage must not leak (via a 500) whether the address was allowed.
async function sendMagicLink(email, rawToken) {
  const link = buildMagicLink(rawToken);
  const apiKey = process.env.RESEND_API_KEY;

  if (!apiKey) {
    // Dev fallback: no email is sent, the link is printed so you can click it.
    console.log(`✉️  [dev] Magic link for ${email}: ${link}`);
    return;
  }

  try {
    const { Resend } = require('resend');
    const resend = new Resend(apiKey);
    const from = process.env.EMAIL_FROM || 'Tubekeep <onboarding@resend.dev>';
    const { subject, text, html } = renderEmail(link);
    await resend.emails.send({ from, to: email, subject, text, html });
  } catch (err) {
    console.error(`❌ Failed to send magic link to ${email}:`, err.message);
  }
}

module.exports = { sendMagicLink, buildMagicLink };
