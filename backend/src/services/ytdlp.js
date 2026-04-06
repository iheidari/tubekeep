const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');

const downloadsDir = path.join(__dirname, '../../downloads');

function runYtDlp(args, options = {}) {
  return new Promise((resolve, reject) => {
    const ytDlp = spawn('yt-dlp', args, {
      timeout: options.timeout || 120000,
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

async function getVideoInfo(url) {
  try {
    const { stdout } = await runYtDlp([
      '--dump-json',
      '--no-download',
      url
    ]);

    const info = JSON.parse(stdout);

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
    // Build format string
    // If mergeWithAudio is true, use "formatId+bestaudio/best" to merge video with best audio
    const formatString = mergeWithAudio 
      ? `${formatId}+bestaudio/best[height<=${formatId.split('x')[1] || 1080}]/best`
      : formatId;

    const args = [
      '-f', formatString,
      '-o', outputTemplate,
      '--newline',
      '--progress',
      '--no-playlist',
      '--extractor-args', 'youtube:player_client=ios,web'
    ];

    // Add merge output format for video+audio combinations
    if (mergeWithAudio) {
      args.push('--merge-output-format', 'mp4');
    }

    args.push(url);

    await runYtDlp(args, {
      onProgress: (line) => {
        const match = line.match(/(\d+\.?\d*)%/);
        if (match && onProgress) {
          onProgress(parseFloat(match[1]));
        }
      }
    });

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

  try {
    // Download audio-only format directly without re-encoding
    // This preserves the original file size and quality
    await runYtDlp([
      '-f', formatId,
      '-o', outputTemplate,
      '--newline',
      '--progress',
      '--no-playlist',
      '--extractor-args', 'youtube:player_client=ios,web',
      url
    ], {
      onProgress: (line) => {
        const match = line.match(/(\d+\.?\d*)%/);
        if (match && onProgress) {
          onProgress(parseFloat(match[1]));
        }
      }
    });

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
