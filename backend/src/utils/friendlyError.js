// Translate raw yt-dlp stderr into short, blame-free, user-facing copy.
//
// yt-dlp's raw stderr leaks internal tooling detail (exit codes, extractor tags,
// enforcement-vendor names) and doesn't tell the user what to do. This maps the
// signatures we recognize to plain messages and everything else to a generic
// fallback. The raw text is still logged server-side for operators — only the
// user-facing string is rewritten.
//
// Matching notes:
// - stderr is multi-line (retry logs, warnings), so match on substrings anywhere.
// - normalize to lowercase first so casing in yt-dlp/YouTube copy can't dodge it.
// - order matters: earlier, more-specific patterns win. YouTube reuses "Video
//   unavailable" as the headline for geo/private/removed alike, so the specific
//   causes are listed BEFORE the broad "unavailable/removed" catch.

const GENERIC_MESSAGE = "Couldn't process this video. Please check the link and try again.";

const ERROR_PATTERNS = [
  {
    // Private video. YouTube: "Private video. Sign in if you've been granted access…"
    pattern: /private video|sign in if you've been granted access|granted access to view/,
    message: "This video is private and can't be downloaded.",
  },
  {
    // Members-only / channel-join-gated content.
    pattern: /members-only|members only|join this channel|available to this channel's members/,
    message: "This video is members-only and can't be accessed.",
  },
  {
    // Age-restricted / bot-check — both demand a signed-in session we don't have.
    pattern:
      /confirm your age|age-restricted|age restricted|confirm you're not a bot|sign in to confirm/,
    message: "This video requires sign-in (age-restricted) and can't be downloaded.",
  },
  {
    // Geo-blocked. Keep ahead of the generic "unavailable" — YouTube prefixes the
    // country message with "Video unavailable" too. Anchor on the full "…available
    // in your country/location/region" phrase so a stray "geo" substring in a video
    // title or path can't misclassify unrelated failures as region-blocked.
    pattern: /available in your (?:country|location|region)|blocked it in your country/,
    message: "This video isn't available in this region.",
  },
  {
    // Live stream / premiere that hasn't started yet.
    pattern:
      /this live event will begin|premieres in|premiere will begin|live event will begin|is not available yet/,
    message: "This is an upcoming or live stream that hasn't started yet.",
  },
  {
    // Unsupported or malformed URL — a generic-extractor / parse failure.
    pattern: /unsupported url|is not a valid url|unable to extract|no video formats found/,
    message: "That link isn't a supported video URL.",
  },
  {
    // Transport failures: spawn/metadata timeout (runYtDlp surfaces "terminated by
    // SIGTERM"), DNS/connection errors, rate limits, or a generic fetch failure.
    pattern:
      /terminated by sig|timed out|timeout|unable to download webpage|connection|network is unreachable|getaddrinfo|name resolution|http error 429|too many requests|read timed out|failed to spawn/,
    message: "Couldn't reach the video right now. Please try again.",
  },
  {
    // Broadest content signal, last among the specifics: removed / taken down /
    // unavailable for any of the reasons not distinguished above.
    pattern:
      /video unavailable|removal request|removed following|has been removed|no longer available|account.*(terminated|closed)|this video has been removed|removed by the uploader|content isn't available/,
    message: 'This video is no longer available — it may have been removed or taken down.',
  },
];

// Map a raw yt-dlp/error message to friendly user-facing copy. Never returns
// internal detail: unrecognized input falls back to the generic message.
function friendlyYtDlpError(rawMessage) {
  // Normalize the U+2019 curly apostrophe YouTube uses ("you've", "you're",
  // "channel's") to a straight quote so the apostrophe-bearing patterns match.
  const text = String(rawMessage || '')
    .toLowerCase()
    .replace(/’/g, "'");
  for (const { pattern, message } of ERROR_PATTERNS) {
    if (pattern.test(text)) return message;
  }
  return GENERIC_MESSAGE;
}

module.exports = { friendlyYtDlpError, GENERIC_MESSAGE };
