/**
 * Converts one uploaded video into adaptive HLS: 1080p / 720p / 480p / 360p.
 *
 *   public/media/hls/<name>/master.m3u8        ← give this URL to the player
 *   public/media/hls/<name>/720p/index.m3u8    ← one playlist per quality
 *   public/media/hls/<name>/720p/seg_0000.ts   ← 6-second pieces
 *
 * The player (hls.js / Safari / ExoPlayer) reads master.m3u8, measures the
 * viewer's bandwidth and picks the best quality piece by piece.
 *
 * Uses the same ffmpeg binary as the rest of the app (ffmpeg-static), or
 * FFMPEG_PATH / FFPROBE_PATH from .env if set.
 */
const { spawn } = require('child_process');
const fs = require('fs/promises');
const path = require('path');

function resolveBinary(envVar, staticModule, pick) {
  if (process.env[envVar]) return process.env[envVar];
  try { return pick(require(staticModule)); } catch (_) { return null; }
}
const FFMPEG = resolveBinary('FFMPEG_PATH', 'ffmpeg-static', (m) => m) || 'ffmpeg';
const FFPROBE = resolveBinary('FFPROBE_PATH', 'ffprobe-static', (m) => m.path) || 'ffprobe';

// Shared hosting limits threads/memory per account. x264 starts ~1.5 threads per
// CPU core for EACH quality by default, which on a big shared server exceeds the
// limit ("Could not open encoder ... Invalid argument"). Cap it.
const THREADS = Math.max(1, parseInt(process.env.FFMPEG_THREADS, 10) || 2);
// HLS_MODE: "auto" (default) = all qualities in one pass, and if that fails,
// one quality at a time. "sequential" = always one at a time (lowest memory).
const HLS_MODE = String(process.env.HLS_MODE || 'auto').toLowerCase();

// Quality ladder. Only rungs at or below the source size are produced (never upscales).
const LADDER = [
  { name: '1080p', height: 1080, vbr: 5000, maxrate: 5350, bufsize: 7500 },
  { name: '720p', height: 720, vbr: 2800, maxrate: 3000, bufsize: 4200 },
  { name: '480p', height: 480, vbr: 1400, maxrate: 1500, bufsize: 2100 },
  { name: '360p', height: 360, vbr: 800, maxrate: 856, bufsize: 1200 },
];

function run(cmd, args, onStdout) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => { out += d; if (onStdout) onStdout(d.toString()); });
    p.stderr.on('data', (d) => { err += d; if (err.length > 20000) err = err.slice(-20000); });
    p.on('error', reject);
    p.on('close', (code) => (code === 0
      ? resolve(out)
      : reject(new Error(`${path.basename(cmd)} exited with code ${code}: ${err.trim().split('\n').slice(-3).join(' ')}`))));
  });
}

async function probe(file) {
  const info = JSON.parse(await run(FFPROBE, [
    '-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', file,
  ]));
  const v = info.streams.find((s) => s.codec_type === 'video');
  if (!v) throw new Error('No video stream found in file');
  // Phone videos are often stored landscape + a rotation flag; use the displayed size.
  const rotation = Math.abs(Number(
    (v.tags && v.tags.rotate)
    ?? (v.side_data_list || []).find((d) => d.rotation !== undefined)?.rotation
    ?? 0
  ));
  const rotated = rotation === 90 || rotation === 270;
  return {
    width: rotated ? v.height : v.width,
    height: rotated ? v.width : v.height,
    duration: Number(info.format.duration) || null,
    hasAudio: info.streams.some((s) => s.codec_type === 'audio'),
  };
}

/**
 * @param {string} input   source video path
 * @param {string} outDir  e.g. public/media/hls/<name>  (created; replaced if it exists)
 * @param {(percent:number)=>void} [onProgress]
 * @returns {Promise<{renditions:string[], width:number, height:number, duration:number|null}>}
 */
async function transcodeToHls(input, outDir, onProgress = () => { }) {
  const src = await probe(input);
  const portrait = src.height > src.width;
  const shortSide = Math.min(src.width, src.height);
  let rungs = LADDER.filter((r) => r.height <= shortSide);
  if (rungs.length === 0) rungs = [LADDER[LADDER.length - 1]]; // very small source → 360p only

  if (HLS_MODE !== 'sequential') {
    try {
      await singlePass(input, outDir, src, rungs, portrait, onProgress);
      return { renditions: rungs.map((r) => r.name), width: src.width, height: src.height, duration: src.duration };
    } catch (err) {
      console.warn(`[hls] all-at-once conversion failed, retrying one quality at a time: ${err.message.slice(0, 200)}`);
    }
  }
  await sequential(input, outDir, src, rungs, portrait, onProgress);
  return { renditions: rungs.map((r) => r.name), width: src.width, height: src.height, duration: src.duration };
}

const commonVideoArgs = () => [
  '-preset', process.env.X264_PRESET || 'veryfast',
  '-profile:v', 'main', '-pix_fmt', 'yuv420p', '-sc_threshold', '0',
  // keyframe every 2s so every quality can switch at the same points
  '-force_key_frames', 'expr:gte(t,n_forced*2)',
];

function progressParser(duration, offset, share, onProgress) {
  let last = -1;
  return (chunk) => {
    const m = chunk.match(/out_time_us=(\d+)/g);
    if (!m || !duration) return;
    const secs = Number(m[m.length - 1].split('=')[1]) / 1e6;
    const pct = Math.max(0, Math.min(99, Math.floor(offset + (secs / duration) * share)));
    if (pct !== last) { last = pct; onProgress(pct); }
  };
}

// All qualities in one ffmpeg run (decodes the source once - fastest).
async function singlePass(input, outDir, src, rungs, portrait, onProgress) {
  await fs.rm(outDir, { recursive: true, force: true });
  await fs.mkdir(outDir, { recursive: true });

  const n = rungs.length;
  const scale = (h) => (portrait ? `scale=${h}:-2` : `scale=-2:${h}`);
  const filter = `[0:v]split=${n}${rungs.map((_, i) => `[s${i}]`).join('')};`
    + rungs.map((r, i) => `[s${i}]${scale(r.height)}[v${i}]`).join(';');

  const args = ['-hide_banner', '-y', '-threads', String(THREADS), '-i', input,
    '-filter_complex_threads', String(THREADS), '-filter_complex', filter];
  rungs.forEach((r, i) => {
    args.push(
      '-map', `[v${i}]`,
      `-c:v:${i}`, 'libx264',
      `-b:v:${i}`, `${r.vbr}k`,
      `-maxrate:v:${i}`, `${r.maxrate}k`,
      `-bufsize:v:${i}`, `${r.bufsize}k`,
      `-threads:v:${i}`, String(THREADS),
    );
  });
  if (src.hasAudio) {
    rungs.forEach(() => args.push('-map', '0:a:0'));
    args.push('-c:a', 'aac', '-b:a', '128k', '-ac', '2');
  }
  args.push(
    ...commonVideoArgs(),
    '-f', 'hls', '-hls_time', '6', '-hls_playlist_type', 'vod',
    '-hls_flags', 'independent_segments',
    '-hls_segment_filename', path.join(outDir, '%v', 'seg_%04d.ts'),
    '-master_pl_name', 'master.m3u8',
    '-var_stream_map', rungs
      .map((r, i) => (src.hasAudio ? `v:${i},a:${i},name:${r.name}` : `v:${i},name:${r.name}`))
      .join(' '),
    '-progress', 'pipe:1', '-nostats',
    path.join(outDir, '%v', 'index.m3u8'),
  );

  await run(FFMPEG, args, progressParser(src.duration, 0, 100, onProgress));
}

// One quality per ffmpeg run: only one encoder in memory at a time, so it
// works within tight shared-hosting limits. Slower (decodes the source per quality).
async function sequential(input, outDir, src, rungs, portrait, onProgress) {
  await fs.rm(outDir, { recursive: true, force: true });
  await fs.mkdir(outDir, { recursive: true });
  const scale = (h) => (portrait ? `scale=${h}:-2` : `scale=-2:${h}`);
  const masterLines = ['#EXTM3U', '#EXT-X-VERSION:3', '#EXT-X-INDEPENDENT-SEGMENTS'];

  for (const [i, r] of rungs.entries()) {
    const dir = path.join(outDir, r.name);
    await fs.mkdir(dir, { recursive: true });
    const args = [
      '-hide_banner', '-y', '-threads', String(THREADS), '-i', input,
      '-map', '0:v:0', '-vf', scale(r.height),
      '-c:v', 'libx264', '-b:v', `${r.vbr}k`, '-maxrate', `${r.maxrate}k`, '-bufsize', `${r.bufsize}k`,
      '-threads', String(THREADS),
      ...commonVideoArgs(),
    ];
    if (src.hasAudio) args.push('-map', '0:a:0', '-c:a', 'aac', '-b:a', '128k', '-ac', '2');
    args.push(
      '-f', 'hls', '-hls_time', '6', '-hls_playlist_type', 'vod',
      '-hls_flags', 'independent_segments',
      '-hls_segment_filename', path.join(dir, 'seg_%04d.ts'),
      // ffmpeg writes a one-quality master here; we copy its accurate
      // BANDWIDTH/RESOLUTION/CODECS line into the combined master below.
      '-master_pl_name', 'variant.m3u8',
      '-progress', 'pipe:1', '-nostats',
      path.join(dir, 'index.m3u8'),
    );
    await run(FFMPEG, args, progressParser(src.duration, (i / rungs.length) * 100, 100 / rungs.length, onProgress));

    const variant = (await fs.readFile(path.join(dir, 'variant.m3u8'), 'utf8')).split(/\r?\n/);
    const inf = variant.find((l) => l.startsWith('#EXT-X-STREAM-INF'));
    masterLines.push(inf || `#EXT-X-STREAM-INF:BANDWIDTH=${(r.maxrate + 128) * 1000}`, `${r.name}/index.m3u8`);
    await fs.rm(path.join(dir, 'variant.m3u8'), { force: true });
  }
  await fs.writeFile(path.join(outDir, 'master.m3u8'), masterLines.join('\n') + '\n');
}

/**
 * Builds a plain MP4 from the top HLS quality WITHOUT re-encoding (a few seconds),
 * so the existing `video_url` keeps working for apps that expect an MP4.
 */
async function remuxToMp4(playlistPath, outputPath) {
  await run(FFMPEG, [
    '-hide_banner', '-y', '-i', playlistPath,
    '-c', 'copy', '-movflags', '+faststart', outputPath,
  ]);
}

module.exports = { transcodeToHls, remuxToMp4, probe, LADDER };