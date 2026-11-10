const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('ffmpeg-static');
const ffprobePath = require('ffprobe-static').path;
const sharp = require('sharp');
const path = require('path');
const fs = require('fs');
const { VIDEOS_DIR, THUMBS_DIR, HLS_DIR } = require('./paths');
const { transcodeToHls, remuxToMp4 } = require('./hlsTranscoder');

// Hostinger (and some Linux hosts) ship npm binaries without +x — ffmpeg then
// fails immediately and every upload lands as status=failed.
function ensureExecutable(binPath) {
  if (!binPath || !fs.existsSync(binPath)) return;
  try {
    fs.chmodSync(binPath, 0o755);
  } catch (_) {
    /* ignore on Windows / restricted FS */
  }
}

ensureExecutable(ffmpegPath);
ensureExecutable(ffprobePath);

if (ffmpegPath) ffmpeg.setFfmpegPath(ffmpegPath);
if (ffprobePath) ffmpeg.setFfprobePath(ffprobePath);

const MAX_HEIGHT = 1080;
const envFlag = (name, fallback) => {
  const v = String(process.env[name] ?? '').trim().toLowerCase();
  if (v === '') return fallback;
  return v === '1' || v === 'true';
};
const SKIP_TRANSCODE = envFlag('SKIP_VIDEO_TRANSCODE', false);
// Adaptive streaming (1080p/720p/480p/360p). Set ENABLE_HLS=0 to go back to single-MP4 mode.
const ENABLE_HLS = envFlag('ENABLE_HLS', true);
// Also keep one MP4 (copied from the 1080p HLS stream, no re-encode) so the
// existing video_url keeps working for apps that expect a plain MP4.
const HLS_KEEP_MP4 = envFlag('HLS_KEEP_MP4', true);

/**
 * Reads duration/width/height from a source file without touching it.
 */
function probe(filePath) {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(filePath, (err, data) => {
      if (err) return reject(err);
      const stream = data.streams.find((s) => s.codec_type === 'video');
      resolve({
        duration: data.format.duration ? parseFloat(data.format.duration) : null,
        width: stream ? stream.width : null,
        height: stream ? stream.height : null,
      });
    });
  });
}

/**
 * Transcodes an uploaded source video into a web-optimized MP4.
 * Returns the output filename (not full path).
 */
function transcodeToMp4(sourcePath, outputBasename) {
  const outputFilename = `${outputBasename}.mp4`;
  const outputPath = path.join(VIDEOS_DIR, outputFilename);

  return new Promise((resolve, reject) => {
    ffmpeg(sourcePath)
      .videoCodec('libx264')
      .audioCodec('aac')
      .audioBitrate('128k')
      .outputOptions([
        '-preset veryfast',
        '-crf 23',
        '-profile:v high',
        '-level 4.1',
        '-movflags +faststart',
        `-vf scale=-2:'min(${MAX_HEIGHT},ih)'`,
        '-pix_fmt yuv420p',
      ])
      .on('error', (err) => reject(err))
      .on('end', () => resolve(outputFilename))
      .save(outputPath);
  });
}

/**
 * Hostinger fallback: keep the uploaded file as-is when ffmpeg cannot run.
 */
function copySourceVideo(sourcePath, outputBasename) {
  const ext = path.extname(sourcePath).toLowerCase() || '.mp4';
  const outputFilename = `${outputBasename}${ext}`;
  const outputPath = path.join(VIDEOS_DIR, outputFilename);
  fs.copyFileSync(sourcePath, outputPath);
  return outputFilename;
}

/**
 * Grabs a frame from the video when the user didn't upload a thumbnail.
 */
function extractThumbnail(videoPath, outputBasename, seekSeconds = 1) {
  const outputFilename = `${outputBasename}.jpg`;
  return new Promise((resolve, reject) => {
    ffmpeg(videoPath)
      .on('error', (err) => reject(err))
      .on('end', () => resolve(outputFilename))
      .screenshots({
        timestamps: [seekSeconds],
        filename: outputFilename,
        folder: THUMBS_DIR,
        size: '640x?',
      });
  });
}

/**
 * Compresses a user-uploaded thumbnail with sharp.
 */
async function optimizeThumbnail(sourcePath, outputBasename) {
  const outputFilename = `${outputBasename}.jpg`;
  const outputPath = path.join(THUMBS_DIR, outputFilename);
  await sharp(sourcePath)
    .resize({ width: 640, withoutEnlargement: true })
    .jpeg({ quality: 78, mozjpeg: true })
    .toFile(outputPath);
  return outputFilename;
}

/**
 * Fallback when sharp is unavailable on the host.
 */
function copyThumbnail(sourcePath, outputBasename) {
  const ext = path.extname(sourcePath).toLowerCase() || '.jpg';
  const safeExt = ['.jpg', '.jpeg', '.png', '.webp'].includes(ext) ? ext : '.jpg';
  const outputFilename = `${outputBasename}${safeExt === '.jpeg' ? '.jpg' : safeExt}`;
  const outputPath = path.join(THUMBS_DIR, outputFilename);
  fs.copyFileSync(sourcePath, outputPath);
  return outputFilename;
}

/**
 * Full pipeline with Hostinger-safe fallbacks:
 *   1. HLS in several qualities (+ an MP4 copy of the top quality)
 *   2. if that fails: the original single-MP4 transcode
 *   3. if ffmpeg can't run at all: keep the uploaded file as-is
 *
 * @param {object} [opts]
 * @param {(percent:number)=>void} [opts.onProgress]  conversion progress 0-99
 */
async function processUploadedMedia(sourcePath, thumbnailSourcePath, { onProgress } = {}) {
  const basename = require('crypto').randomBytes(8).toString('hex');
  let meta = { duration: null, width: null, height: null };
  let videoFilename = null;
  let hlsName = null;
  let renditions = [];
  const notes = [];

  if (SKIP_TRANSCODE) {
    notes.push('SKIP_VIDEO_TRANSCODE=1');
    videoFilename = copySourceVideo(sourcePath, basename);
  } else {
    if (ENABLE_HLS) {
      const hlsDir = path.join(HLS_DIR, basename);
      try {
        const hls = await transcodeToHls(sourcePath, hlsDir, onProgress);
        hlsName = basename;
        renditions = hls.renditions;
        meta = { duration: hls.duration, width: hls.width, height: hls.height };

        if (HLS_KEEP_MP4) {
          try {
            videoFilename = `${basename}.mp4`;
            await remuxToMp4(
              path.join(hlsDir, renditions[0], 'index.m3u8'),
              path.join(VIDEOS_DIR, videoFilename)
            );
          } catch (err) {
            notes.push(`mp4 copy skipped: ${err.message}`);
            videoFilename = null;
          }
        }
      } catch (err) {
        fs.rmSync(hlsDir, { recursive: true, force: true });
        // ffmpeg ran fine but the file itself is broken → fail clearly instead of
        // "copying the original" (that fallback is only for hosts where ffmpeg can't run).
        if (/Invalid data found|No video stream|moov atom not found/i.test(err.message)) {
          throw new Error('This file is not a valid or complete video - please re-export and upload again');
        }
        notes.push(`hls failed, used single mp4: ${err.message}`);
        console.warn('[videoProcessor] HLS failed, falling back to MP4:', err.message);
        hlsName = null;
        renditions = [];
      }
    }

    if (!hlsName) {
      try {
        meta = await probe(sourcePath);
        videoFilename = await transcodeToMp4(sourcePath, basename);
      } catch (err) {
        notes.push(`transcode skipped: ${err.message}`);
        console.warn('[videoProcessor] ffmpeg failed, copying original:', err.message);
        videoFilename = copySourceVideo(sourcePath, basename);
      }
    }
  }

  let thumbnailFilename = null;
  if (thumbnailSourcePath && fs.existsSync(thumbnailSourcePath)) {
    try {
      thumbnailFilename = await optimizeThumbnail(thumbnailSourcePath, basename);
    } catch (err) {
      notes.push(`sharp skipped: ${err.message}`);
      console.warn('[videoProcessor] sharp failed, copying thumbnail:', err.message);
      try {
        thumbnailFilename = copyThumbnail(thumbnailSourcePath, basename);
      } catch (copyErr) {
        notes.push(`thumbnail copy failed: ${copyErr.message}`);
      }
    }
  } else {
    try {
      // Grab the frame from the source upload (still on disk at this point),
      // so this works whether or not an MP4 was produced.
      thumbnailFilename = await extractThumbnail(sourcePath, basename);
    } catch (err) {
      notes.push(`frame extract skipped: ${err.message}`);
      console.warn('[videoProcessor] thumbnail extract failed:', err.message);
    }
  }

  let fileSize = 0;
  if (videoFilename) {
    const videoPath = path.join(VIDEOS_DIR, videoFilename);
    if (!fs.existsSync(videoPath)) throw new Error('Video file was not written to disk');
    fileSize = fs.statSync(videoPath).size;
  }
  if (hlsName) fileSize += dirSize(path.join(HLS_DIR, hlsName));
  if (!videoFilename && !hlsName) throw new Error('No playable output was produced');

  return {
    videoFilename,
    hlsName,
    renditions,
    thumbnailFilename,
    meta,
    fileSize,
    notes: notes.join(' | ').slice(0, 500) || null,
  };
}

function dirSize(dir) {
  let total = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    total += entry.isDirectory() ? dirSize(p) : fs.statSync(p).size;
  }
  return total;
}

function safeUnlink(filePath) {
  if (!filePath) return;
  fs.unlink(filePath, () => {});
}

module.exports = {
  probe,
  transcodeToMp4,
  extractThumbnail,
  optimizeThumbnail,
  copySourceVideo,
  copyThumbnail,
  processUploadedMedia,
  safeUnlink,
  VIDEOS_DIR,
  THUMBS_DIR,
  HLS_DIR,
};
