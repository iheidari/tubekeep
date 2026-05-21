const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');

const downloadsDir = path.join(__dirname, '../../downloads');

// Use the updated yt-dlp binary from ~/.local/bin if available, else fall back to system
const homeBin = path.join(process.env.HOME || '', '.local', 'bin');
const localYtDlp = path.join(homeBin, 'yt-dlp');
const ytDlpBin = fs.existsSync(localYtDlp) ? localYtDlp : 'yt-dlp';

// Ensure Node.js is in PATH for yt-dlp's SABR challenge solver
const nodeDir = path.dirname(process.execPath);
const ytDlpEnv = {
  ...process.env,
  PATH: [nodeDir, homeBin, process.env.PATH].filter(Boolean).join(':')
};

console.log(`🔧 Using yt-dlp binary: ${ytDlpBin}`);
console.log(`🔧 Node.js for yt-dlp: ${process.execPath}`);

// YouTube's default web/tv clients require JS challenge solving that's currently
// broken in yt-dlp 2026.02.x, returning only a single 360p combined format and
// hanging mid-download. `android_vr` bypasses both issues — full quality ladder
// (144p → 4K) plus reliable downloads. `formats=missing_pot` keeps formats whose
// URLs lack a PO Token so SABR-affected sessions still surface options.
// Namespaced under `youtube:` so other extractors are unaffected.
const YOUTUBE_EXTRACTOR_ARGS = 'youtube:player_client=android_vr;formats=missing_pot';

function runYtDlp(args, options = {}) {
  return new Promise((resolve, reject) => {
    const ytDlp = spawn(ytDlpBin, args, {
      timeout: options.timeout || 120000,
      env: ytDlpEnv,
      ...options.spawnOptions
    });

    let stdout = '';
    let stderr = '';

    ytDlp.stdout.on('data', (data) => {
      stdout += data.toString();
      if (options.onProgress) {
        const lines = data.toString().split('\n');
        lines.forEach(line => {
          if (line.includes('%')) {
            options.onProgress(line);
          }
        });
      }
    });

    ytDlp.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    ytDlp.on('close', (code) => {
      if (code !== 0 && code !== null) {
        reject(new Error(`yt-dlp exited with code ${code}: ${stderr || stdout}`));
      } else {
        resolve({ stdout, stderr });
      }
    });

    ytDlp.on('error', (err) => {
      reject(new Error(`Failed to spawn yt-dlp: ${err.message}`));
    });
  });
}

async function fetchYouTubeInfo(url) {
  const { stdout } = await runYtDlp([
    '--extractor-args', YOUTUBE_EXTRACTOR_ARGS,
    '--dump-json',
    '--no-download',
    '--no-playlist',
    url
  ]);
  return JSON.parse(stdout);
}

async function getVideoInfo(url) {
  try {
    // YouTube's android_vr client is the only one currently bypassing the broken
    // JS-challenge solver, but YouTube's per-session SABR experiment intermittently
    // strips video URLs. Retry with a small back-off until the full ladder appears.
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    let info = await fetchYouTubeInfo(url);
    const videoOnlyCount = (i) =>
      i.formats.filter(f => f.vcodec !== 'none' && f.acodec === 'none').length;

    for (let attempt = 1; attempt <= 4 && videoOnlyCount(info) === 0; attempt++) {
      console.log(`⚠️  No video-only formats on attempt ${attempt}, retrying after ${attempt * 500}ms…`);
      await sleep(attempt * 500);
      info = await fetchYouTubeInfo(url);
    }

    console.log(`📊 yt-dlp returned ${info.formats.length} total formats for: ${info.title}`);
    console.log(`   Video-only: ${info.formats.filter(f => f.vcodec !== 'none' && f.acodec === 'none').length}`);
    console.log(`   Audio-only: ${info.formats.filter(f => f.acodec !== 'none' && f.vcodec === 'none').length}`);
    console.log(`   Combined: ${info.formats.filter(f => f.vcodec !== 'none' && f.acodec !== 'none').length}`);

    const videoFormats = info.formats
      .filter(f => f.vcodec !== 'none' && f.acodec === 'none')
      .map(f => ({
        formatId: f.format_id,
        ext: f.ext,
        resolution: f.resolution,
        filesize: f.filesize || f.filesize_approx,
        vcodec: f.vcodec,
        fps: f.fps,
        quality: f.quality,
        formatNote: f.format_note
      }));

    const audioFormats = info.formats
      .filter(f => f.acodec !== 'none' && f.vcodec === 'none')
      .map(f => ({
        formatId: f.format_id,
        ext: f.ext,
        filesize: f.filesize || f.filesize_approx,
        acodec: f.acodec,
        abr: f.abr,
        asr: f.asr,
        audioChannels: f.audio_channels
      }));

    const combinedFormats = info.formats
      .filter(f => f.vcodec !== 'none' && f.acodec !== 'none')
      .map(f => ({
        formatId: f.format_id,
        ext: f.ext,
        resolution: f.resolution,
        filesize: f.filesize || f.filesize_approx,
        vcodec: f.vcodec,
        acodec: f.acodec,
        fps: f.fps,
        quality: f.quality,
        formatNote: f.format_note
      }));

    const subtitles = {};
    if (info.subtitles) {
      Object.entries(info.subtitles).forEach(([lang, formats]) => {
        subtitles[lang] = formats.map(f => ({
          url: f.url,
          ext: f.ext
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
        combined: combinedFormats
      },
      subtitles,
      chapters: info.chapters || []
    };
  } catch (error) {
    throw new Error(`Failed to get video info: ${error.message}`);
  }
}

async function downloadVideo(url, formatId, downloadId, onProgress, mergeWithAudio = false) {
  const downloadPath = path.join(downloadsDir, downloadId);
  
  if (!fs.existsSync(downloadPath)) {
    fs.mkdirSync(downloadPath, { recursive: true });
  }

  const outputTemplate = path.join(downloadPath, '%(title)s.%(ext)s');

  try {
    // YouTube's SABR experiment can strip the URL from the exact format ID we
    // surfaced at info-fetch time. Fall back to bestvideo+bestaudio so the
    // download still succeeds when the specific format becomes unavailable.
    const formatString = mergeWithAudio
      ? `${formatId}+bestaudio/bestvideo+bestaudio/best`
      : `${formatId}/best`;

    const args = [
      '--extractor-args', YOUTUBE_EXTRACTOR_ARGS,
      '-f', formatString,
      '-o', outputTemplate,
      '--newline',
      '--progress',
      '--no-playlist'
    ];

    // Add merge output format for video+audio combinations
    if (mergeWithAudio) {
      args.push('--merge-output-format', 'mp4');
    }

    args.push(url);

    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    let lastError;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        await runYtDlp(args, {
          onProgress: (line) => {
            const match = line.match(/(\d+\.?\d*)%/);
            if (match && onProgress) {
              onProgress(parseFloat(match[1]));
            }
          }
        });
        lastError = null;
        break;
      } catch (err) {
        lastError = err;
        const retriable = /Requested format is not available|SABR|missing a URL/i.test(err.message);
        if (!retriable || attempt === 3) throw err;
        console.log(`⚠️  Video download attempt ${attempt} failed (${err.message.split('\n')[0]}), retrying after ${attempt * 750}ms…`);
        await sleep(attempt * 750);
      }
    }
    if (lastError) throw lastError;

    const files = fs.readdirSync(downloadPath);
    const videoFile = files.find(f => 
      ['.mp4', '.webm', '.mkv', '.mov'].some(ext => f.endsWith(ext))
    );

    if (!videoFile) {
      throw new Error('Downloaded file not found');
    }

    const stats = fs.statSync(path.join(downloadPath, videoFile));

    return {
      downloadId,
      filename: videoFile,
      path: path.join(downloadPath, videoFile),
      size: stats.size,
      createdAt: stats.birthtime,
      relativePath: path.join(downloadId, videoFile)
    };
  } catch (error) {
    if (fs.existsSync(downloadPath)) {
      fs.rmSync(downloadPath, { recursive: true, force: true });
    }
    throw error;
  }
}

async function downloadAudio(url, formatId, downloadId, onProgress) {
  const downloadPath = path.join(downloadsDir, downloadId);

  if (!fs.existsSync(downloadPath)) {
    fs.mkdirSync(downloadPath, { recursive: true });
  }

  const outputTemplate = path.join(downloadPath, '%(title)s.%(ext)s');

  // YouTube's SABR experiment can strip the URL from the exact format ID we
  // surfaced at info-fetch time. Fall back through bestaudio variants so the
  // download succeeds with whatever audio yt-dlp can actually pull this session.
  const formatString = `${formatId}/bestaudio[ext=m4a]/bestaudio/best`;
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  try {
    let lastError;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        await runYtDlp([
          '--extractor-args', YOUTUBE_EXTRACTOR_ARGS,
          '-f', formatString,
          '-o', outputTemplate,
          '--newline',
          '--progress',
          '--no-playlist',
          url
        ], {
          onProgress: (line) => {
            const match = line.match(/(\d+\.?\d*)%/);
            if (match && onProgress) {
              onProgress(parseFloat(match[1]));
            }
          }
        });
        lastError = null;
        break;
      } catch (err) {
        lastError = err;
        const retriable = /Requested format is not available|SABR|missing a URL/i.test(err.message);
        if (!retriable || attempt === 3) throw err;
        console.log(`⚠️  Audio download attempt ${attempt} failed (${err.message.split('\n')[0]}), retrying after ${attempt * 750}ms…`);
        await sleep(attempt * 750);
      }
    }
    if (lastError) throw lastError;

    const files = fs.readdirSync(downloadPath);
    const audioFile = files.find(f =>
      ['.mp3', '.m4a', '.webm', '.ogg', '.opus', '.wav', '.flac'].some(ext => f.toLowerCase().endsWith(ext))
    );

    if (!audioFile) {
      throw new Error('Downloaded audio file not found');
    }

    const stats = fs.statSync(path.join(downloadPath, audioFile));

    return {
      downloadId,
      filename: audioFile,
      path: path.join(downloadPath, audioFile),
      size: stats.size,
      createdAt: stats.birthtime,
      relativePath: path.join(downloadId, audioFile)
    };
  } catch (error) {
    if (fs.existsSync(downloadPath)) {
      fs.rmSync(downloadPath, { recursive: true, force: true });
    }
    throw error;
  }
}

async function downloadSubtitle(url, lang, ext, downloadId) {
  const downloadPath = path.join(downloadsDir, downloadId);
  
  if (!fs.existsSync(downloadPath)) {
    fs.mkdirSync(downloadPath, { recursive: true });
  }

  const outputTemplate = path.join(downloadPath, '%(title)s');

  try {
    await runYtDlp([
      '--extractor-args', YOUTUBE_EXTRACTOR_ARGS,
      '--write-sub',
      '--sub-langs', lang,
      '--convert-subs', ext || 'srt',
      '--skip-download',
      '-o', outputTemplate,
      '--no-playlist',
      url
    ]);

    const files = fs.readdirSync(downloadPath);
    const subtitleFile = files.find(f => 
      f.includes(lang) && ['.srt', '.vtt', '.ass'].some(e => f.endsWith(e))
    );

    if (!subtitleFile) {
      throw new Error('Subtitle file not found');
    }

    const stats = fs.statSync(path.join(downloadPath, subtitleFile));

    return {
      downloadId,
      filename: subtitleFile,
      path: path.join(downloadPath, subtitleFile),
      size: stats.size,
      createdAt: stats.birthtime,
      relativePath: path.join(downloadId, subtitleFile)
    };
  } catch (error) {
    throw error;
  }
}

module.exports = {
  getVideoInfo,
  downloadVideo,
  downloadAudio,
  downloadSubtitle,
  downloadsDir
};
