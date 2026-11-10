const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');

// Final media lives under public/ so Hostinger + express.static map
// /media/thumbnails/x.jpg → public/media/thumbnails/x.jpg directly.
const VIDEOS_DIR = path.join(ROOT, 'public', 'media', 'videos');
const THUMBS_DIR = path.join(ROOT, 'public', 'media', 'thumbnails');
// Adaptive streaming output: public/media/hls/<name>/master.m3u8 + one folder per quality.
const HLS_DIR = path.join(ROOT, 'public', 'media', 'hls');
// Temp uploads stay outside public/ (never web-served).
const TMP_DIR = path.join(ROOT, 'uploads', 'tmp');

for (const dir of [VIDEOS_DIR, THUMBS_DIR, HLS_DIR, TMP_DIR]) {
  fs.mkdirSync(dir, { recursive: true });
}

module.exports = { ROOT, VIDEOS_DIR, THUMBS_DIR, HLS_DIR, TMP_DIR };
