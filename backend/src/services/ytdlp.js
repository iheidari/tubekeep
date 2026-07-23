const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const { ensureDownloadDir, deleteDownload } = require('../utils/storage');
const { friendlyYtDlpError } = require('../utils/friendlyError');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Use the updated yt-dlp binary from ~/.local/bin if available, else fall back to system
const homeBin = path.join(process.env.HOME || '', '.local', 'bin');
const localYtDlp = path.join(homeBin, 'yt-dlp');
const ytDlpBin = fs.existsSync(localYtDlp) ? localYtDlp : 'yt-dlp';

// Ensure Node.js is in PATH for yt-dlp's SABR challenge solver
const nodeDir = path.dirname(process.execPath);
const ytDlpEnv = {
  ...process.env,
  PATH: [nodeDir, homeBin, process.env.PATH].filter(Boolean).join(':'),
};

console.log(`🔧 Using yt-dlp binary: ${ytDlpBin}`);
console.log(`🔧 Node.js for yt-dlp: ${process.execPath}`);

// yt-dlp subprocess timeouts. A metadata dump should return quickly — a hung one
// is a failure. Downloads legitimately run for many minutes (a large HLS video is
// thousands of small fragments), so they get a far more generous cap — but still a
// finite one, so a genuinely wedged yt-dlp is eventually reaped instead of leaking
// a process and its pipes forever.
const METADATA_TIMEOUT_MS = 2 * 60 * 1000;
const DOWNLOAD_TIMEOUT_MS = 60 * 60 * 1000;

// YouTube's default web/tv clients require JS challenge solving that's currently
// broken in yt-dlp 2026.02.x, returning only a single 360p combined format and
// hanging mid-download. `android_vr` bypasses both issues — full quality ladder
// (144p → 4K) plus reliable downloads. `formats=missing_pot` keeps formats whose
// URLs lack a PO Token so SABR-affected sessions still surface options.
// Namespaced under `youtube:` so other extractors are unaffected.
const YOUTUBE_EXTRACTOR_ARGS = 'youtube:player_client=android_vr;formats=missing_pot';

// The URL is forwarded verbatim to `yt-dlp <url>`. yt-dlp's generic extractor
// happily accepts file:// (local read) and internal http hosts (SSRF pivot),
// so only allow real http(s) URLs before anything is spawned.
function isSupportedUrl(value) {
  if (typeof value !== 'string') return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

// On a network that advertises an IPv6 default route but black-holes IPv6
// traffic, every yt-dlp call stalls ~80s: Python's urllib has no Happy Eyeballs,
// so it waits out the full TCP timeout on each AAAA address before falling back
// to IPv4. Setting YTDLP_FORCE_IPV4=true skips the AAAA attempt entirely (~1.5s
// instead of ~85s). Opt-in, not default — it would break an IPv6-only host.
const FORCE_IPV4 = process.env.YTDLP_FORCE_IPV4 === 'true';

if (FORCE_IPV4) {
  console.log('🔧 yt-dlp: forcing IPv4 (YTDLP_FORCE_IPV4=true)');
}

// Flags that must be on EVERY invocation. Owned here, at the single spawn
// chokepoint, rather than remembered at each call site — a new call site that
// forgot `--extractor-args` would silently regress YouTube to the broken
// 360p/hang path. Prepended, not appended: the URL is always the last argument.
function universalArgs() {
  const prefix = FORCE_IPV4 ? ['--force-ipv4'] : [];
  return [...prefix, '--extractor-args', YOUTUBE_EXTRACTOR_ARGS];
}

function runYtDlp(args, options = {}) {
  const finalArgs = [...universalArgs(), ...args];
  return new Promise((resolve, reject) => {
    const ytDlp = spawn(options.binary || ytDlpBin, finalArgs, {
      // `binary` is a test-injection seam; production always uses ytDlpBin.
      // `??` (not `||`) so an explicit `timeout: 0` can disable the cap entirely.
      timeout: options.timeout ?? METADATA_TIMEOUT_MS,
      env: ytDlpEnv,
      signal: options.signal,
    });

    let stdout = '';
    let stderr = '';

    ytDlp.stdout.on('data', (data) => {
      stdout += data.toString();
      if (options.onProgress) {
        const lines = data.toString().split('\n');
        lines.forEach((line) => {
          if (line.includes('%')) {
            options.onProgress(line);
          }
        });
      }
    });

    ytDlp.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    ytDlp.on('close', (code, signal) => {
      if (code === 0) {
        resolve({ stdout, stderr });
      } else if (signal) {
        // Killed by a signal — the spawn timeout, a client-disconnect abort, or
        // the OS. A half-written download is NOT a success: reject so the caller
        // surfaces a real error instead of hunting for a file that was never
        // finished ("Downloaded file not found").
        reject(new Error(`yt-dlp was terminated by ${signal}: ${stderr || stdout}`));
      } else {
        reject(new Error(`yt-dlp exited with code ${code}: ${stderr || stdout}`));
      }
    });

    ytDlp.on('error', (err) => {
      reject(new Error(`Failed to spawn yt-dlp: ${err.message}`));
    });
  });
}

async function fetchYouTubeInfo(url) {
  const { stdout } = await runYtDlp(['--dump-json', '--no-download', '--no-playlist', url]);
  return JSON.parse(stdout);
}

// Pure: derive available caption languages from the raw --dump-json payload,
// split by kind — yt-dlp exposes human-authored captions under `subtitles`
// and auto-generated ones under a separate `automatic_captions` map. Exported
// so this can be unit-tested without spawning yt-dlp (see 0XC-14).
function buildCaptions(info) {
  return {
    manual: Object.keys(info.subtitles || {}),
    auto: Object.keys(info.automatic_captions || {}),
  };
}

async function getVideoInfo(url) {
  try {
    // YouTube's android_vr client is the only one currently bypassing the broken
    // JS-challenge solver, but YouTube's per-session SABR experiment intermittently
    // strips video URLs. Retry with a small back-off until the full ladder appears.
    let info = await fetchYouTubeInfo(url);
    const videoOnlyCount = (i) =>
      i.formats.filter((f) => f.vcodec !== 'none' && f.acodec === 'none').length;

    for (let attempt = 1; attempt <= 4 && videoOnlyCount(info) === 0; attempt++) {
      console.log(
        `⚠️  No video-only formats on attempt ${attempt}, retrying after ${attempt * 500}ms…`,
      );
      await sleep(attempt * 500);
      info = await fetchYouTubeInfo(url);
    }

    const videoFormats = info.formats
      .filter((f) => f.vcodec !== 'none' && f.acodec === 'none')
      .map((f) => ({
        formatId: f.format_id,
        ext: f.ext,
        resolution: f.resolution,
        filesize: f.filesize || f.filesize_approx,
        vcodec: f.vcodec,
        fps: f.fps,
        quality: f.quality,
        formatNote: f.format_note,
      }));

    const audioFormats = info.formats
      .filter((f) => f.acodec !== 'none' && f.vcodec === 'none')
      .map((f) => ({
        formatId: f.format_id,
        ext: f.ext,
        filesize: f.filesize || f.filesize_approx,
        acodec: f.acodec,
        abr: f.abr,
        asr: f.asr,
        audioChannels: f.audio_channels,
      }));

    const combinedFormats = info.formats
      .filter((f) => f.vcodec !== 'none' && f.acodec !== 'none')
      .map((f) => ({
        formatId: f.format_id,
        ext: f.ext,
        resolution: f.resolution,
        filesize: f.filesize || f.filesize_approx,
        vcodec: f.vcodec,
        acodec: f.acodec,
        fps: f.fps,
        quality: f.quality,
        formatNote: f.format_note,
      }));

    console.log(`📊 yt-dlp returned ${info.formats.length} total formats for: ${info.title}`);
    console.log(`   Video-only: ${videoFormats.length}`);
    console.log(`   Audio-only: ${audioFormats.length}`);
    console.log(`   Combined: ${combinedFormats.length}`);

    const subtitles = {};
    if (info.subtitles) {
      Object.entries(info.subtitles).forEach(([lang, formats]) => {
        subtitles[lang] = formats.map((f) => ({
          url: f.url,
          ext: f.ext,
        }));
      });
    }

    return {
      id: info.id,
      title: info.title,
      description: info.description,
      duration: info.duration,
      thumbnail: info.thumbnail,
      uploader: info.uploader,
      uploadDate: info.upload_date,
      webpageUrl: info.webpage_url,
      formats: {
        video: videoFormats,
        audio: audioFormats,
        combined: combinedFormats,
      },
      subtitles,
      captions: buildCaptions(info),
      chapters: info.chapters || [],
    };
  } catch (error) {
    // Log the full raw stderr for operators, but hand the user friendly copy —
    // yt-dlp's raw message leaks exit codes, extractor tags, and enforcement
    // vendor names (see 0XC-95).
    console.error(`❌ Fetch error for ${url}:`, error.message);
    throw new Error(friendlyYtDlpError(error.message));
  }
}

// yt-dlp writes into an otherwise-empty per-download dir; locate the produced
// media file by extension and describe it for the routes/storage layer.
function describeDownloadedFile(downloadPath, downloadId, extensions, notFoundMessage) {
  const files = fs.readdirSync(downloadPath);
  // Pick the LARGEST matching file, not the first: a partial SABR retry can
  // leave intermediate .webm/.m4a fragments next to the final merged .mp4, and
  // the merged output is always the biggest — serving a fragment breaks playback.
  const largest = files
    .filter((f) => extensions.some((ext) => f.toLowerCase().endsWith(ext)))
    .map((f) => {
      try {
        return { f, stat: fs.statSync(path.join(downloadPath, f)) };
      } catch {
        return { f, stat: null };
      }
    })
    .sort((a, b) => (b.stat?.size || 0) - (a.stat?.size || 0))[0];

  if (!largest?.stat) {
    throw new Error(notFoundMessage);
  }

  const { f: filename, stat } = largest;

  return {
    downloadId,
    filename,
    path: path.join(downloadPath, filename),
    size: stat.size,
    createdAt: stat.birthtime,
    relativePath: path.join(downloadId, filename),
  };
}

// Fraction of the progress bar allotted to the video sub-stream of a merged
// download; the remainder covers the audio sub-stream. Video is the larger,
// slower half, so it owns most of the bar. See `weightMerge` below.
const VIDEO_PHASE_WEIGHT = 0.9;

// Run a download, retrying the transient SABR/format failures YouTube throws
// mid-session. `label` only tags the retry log line ("Video"/"Audio").
// `weightMerge` folds a two-sub-stream merged download into one monotonic bar
// (see below); leave it false for single-stream (audio-only / pre-merged).
async function runDownloadWithRetry(args, onProgress, label, signal, weightMerge = false) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    if (signal?.aborted) throw new Error('Download aborted');
    try {
      // A merged video download runs ONE yt-dlp process that pulls the video
      // sub-stream (0→100%) then the audio sub-stream (0→100%) before merging,
      // so the raw percentage resets from ~100 back to ~0 at the boundary —
      // the client would otherwise see the bar fill, snap back, and fill again.
      // When `weightMerge`, detect that reset and remap each sub-stream into a
      // slice of a single 0→100 bar (video 0–90%, audio 90–100%) so progress
      // only ever moves forward.
      let phase = 1;
      let lastPct = -1;
      await runYtDlp(args, {
        signal,
        // Downloads get the generous cap, not the short metadata default.
        timeout: DOWNLOAD_TIMEOUT_MS,
        onProgress: (line) => {
          const match = line.match(/(\d+\.?\d*)%/);
          if (!match || !onProgress) return;
          const pct = Number.parseFloat(match[1]);
          // A drop of >30 points means yt-dlp started the next sub-stream.
          if (lastPct - pct > 30) phase++;
          lastPct = pct;
          if (!weightMerge) {
            onProgress(pct);
          } else if (phase === 1) {
            onProgress(pct * VIDEO_PHASE_WEIGHT);
          } else {
            onProgress(VIDEO_PHASE_WEIGHT * 100 + pct * (1 - VIDEO_PHASE_WEIGHT));
          }
        },
      });
      return;
    } catch (err) {
      const retriable = /Requested format is not available|SABR|missing a URL/i.test(err.message);
      if (!retriable || attempt === 3) throw err;
      console.log(
        `⚠️  ${label} download attempt ${attempt} failed (${err.message.split('\n')[0]}), retrying after ${attempt * 750}ms…`,
      );
      await sleep(attempt * 750);
    }
  }
}

async function downloadVideo(
  url,
  formatId,
  downloadId,
  onProgress,
  mergeWithAudio = false,
  signal,
) {
  const downloadPath = ensureDownloadDir(downloadId);
  const outputTemplate = path.join(downloadPath, '%(title)s.%(ext)s');

  try {
    // YouTube's SABR experiment can strip the URL from the exact format ID we
    // surfaced at info-fetch time. Fall back to bestvideo+bestaudio so the
    // download still succeeds when the specific format becomes unavailable.
    const formatString = mergeWithAudio
      ? `${formatId}+bestaudio/bestvideo+bestaudio/best`
      : `${formatId}/best`;

    const args = [
      '-f',
      formatString,
      '-o',
      outputTemplate,
      '--newline',
      '--progress',
      // Pull several fragments at once for fragmented (HLS/DASH) streams — a
      // 2–4× speedup on transfer-bound downloads. No-op on single-URL streams.
      '--concurrent-fragments',
      '4',
      '--no-playlist',
    ];

    // Add merge output format for video+audio combinations
    if (mergeWithAudio) {
      args.push('--merge-output-format', 'mp4');
    }

    args.push(url);

    // Only the merge path has two sub-streams to fold into one bar; a
    // pre-merged (combined) format is a single stream — report it straight.
    await runDownloadWithRetry(args, onProgress, 'Video', signal, mergeWithAudio);

    return describeDownloadedFile(
      downloadPath,
      downloadId,
      ['.mp4', '.webm', '.mkv', '.mov'],
      'Downloaded file not found',
    );
  } catch (error) {
    deleteDownload(downloadId);
    throw error;
  }
}

async function downloadAudio(url, formatId, downloadId, onProgress, signal) {
  const downloadPath = ensureDownloadDir(downloadId);
  const outputTemplate = path.join(downloadPath, '%(title)s.%(ext)s');

  // YouTube's SABR experiment can strip the URL from the exact format ID we
  // surfaced at info-fetch time. Fall back through bestaudio variants so the
  // download succeeds with whatever audio yt-dlp can actually pull this session.
  const formatString = `${formatId}/bestaudio[ext=m4a]/bestaudio/best`;

  try {
    await runDownloadWithRetry(
      [
        '-f',
        formatString,
        '-o',
        outputTemplate,
        '--newline',
        '--progress',
        '--concurrent-fragments',
        '4',
        '--no-playlist',
        url,
      ],
      onProgress,
      'Audio',
      signal,
    );

    return describeDownloadedFile(
      downloadPath,
      downloadId,
      ['.mp3', '.m4a', '.webm', '.ogg', '.opus', '.wav', '.flac'],
      'Downloaded audio file not found',
    );
  } catch (error) {
    deleteDownload(downloadId);
    throw error;
  }
}

module.exports = {
  getVideoInfo,
  downloadVideo,
  downloadAudio,
  isSupportedUrl,
  runYtDlp,
  buildCaptions,
};
