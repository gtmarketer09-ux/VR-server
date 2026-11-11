require('dotenv').config();
const express = require('express');
const session = require('express-session');
const path = require('path');
const fs = require('fs');

// Creates the media folders (public/media or MEDIA_ROOT) + temp folder before routes load.
const { VIDEOS_DIR, THUMBS_DIR, HLS_DIR } = require('./utils/paths');
const db = require('./config/db');
const { ensureVideoColumns } = require('./utils/schema');
const { resumePending } = require('./utils/videoQueue');

const authRoutes = require('./routes/auth');
const categoryRoutes = require('./routes/categories');
const videoRoutes = require('./routes/videos');

const app = express();
const PORT = process.env.PORT || 8080;
const isHttpsPublic =
  (process.env.PUBLIC_BASE_URL || '').startsWith('https://') ||
  process.env.NODE_ENV === 'production';

// Required when Node sits behind Hostinger/nginx TLS termination, so
// req.protocol / secure cookies reflect the public HTTPS URL.
app.set('trust proxy', 1);

// Video uploads use multipart (multer), not these parsers — still raise limits
// so any JSON/urlencoded admin calls aren't capped at Express defaults.
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

app.use(
  session({
    secret: process.env.SESSION_SECRET || 'dev-secret-change-me',
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      secure: isHttpsPublic,
      maxAge: 1000 * 60 * 60 * 12, // 12 hours
      sameSite: 'lax',
    },
  })
);

// API
app.use('/api/auth', authRoutes);
app.use('/api/categories', categoryRoutes);
app.use('/api/videos', videoRoutes);

// Media under public/media/... so URL /media/thumbnails/x.jpg matches disk.
// fallthrough:false → real 404 if the file is missing (common after Hostinger redeploy).
app.use(
  '/media/videos',
  express.static(VIDEOS_DIR, {
    maxAge: '30d',
    acceptRanges: true,
    fallthrough: false,
  })
);
// Local testing only: /bandwidth-test.html can slow down video pieces to
// simulate a bad connection. Never active in production.
if (process.env.NODE_ENV !== 'production') {
  app.use('/media/hls', require('./utils/devThrottle')(HLS_DIR));
  // lets the test page confirm the slowdown is actually active
  app.get('/api/dev/throttle-status', (req, res) => {
    const m = /(?:^|;\s*)sim_kbps=(\d+)/.exec(req.headers.cookie || '');
    res.json({ active: true, simKbps: m ? Number(m[1]) : 0 });
  });
}

// Adaptive streams: /media/hls/<name>/master.m3u8, /<name>/720p/index.m3u8, /<name>/720p/seg_0001.ts
app.use(
  '/media/hls',
  express.static(HLS_DIR, {
    fallthrough: false,
    setHeaders(res, filePath) {
      // CORS so hls.js players on other domains/apps can load the stream
      // (a plain <video src=mp4> doesn't need this, but HLS fetches via XHR).
      res.setHeader('Access-Control-Allow-Origin', '*');
      if (filePath.endsWith('.m3u8')) {
        res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
        res.setHeader('Cache-Control', 'public, max-age=60');
      } else if (filePath.endsWith('.ts')) {
        res.setHeader('Content-Type', 'video/mp2t');
        // segments never change once written
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      }
    },
  })
);
app.use(
  '/media/thumbnails',
  express.static(THUMBS_DIR, {
    maxAge: '30d',
    fallthrough: false,
  })
);

// Front-end pages (also covers /media/* if files exist under public/media)
app.use(express.static(path.join(__dirname, 'public')));

// Helpful when a DB row still points at a wiped file after redeploy.
app.use('/media', (req, res) => {
  console.warn(`Media 404: ${req.originalUrl} (file missing on disk)`);
  res.status(404).type('text').send('Media file not found on server disk');
});

const server = app.listen(PORT, () => {
  // Add HLS columns to an existing DB if needed, then continue any
  // conversions that were interrupted by a restart.
  ensureVideoColumns(db)
    .then(resumePending)
    .catch((err) => console.error('[startup] video schema/queue init failed:', err.message));

  console.log(`Video CMS running on port ${PORT}`);
  console.log(`Media dirs: videos=${VIDEOS_DIR} thumbs=${THUMBS_DIR} hls=${HLS_DIR}`);
  if (!process.env.MEDIA_ROOT && /[\\/]hbuilds[\\/]/.test(__dirname)) {
    console.warn(
      'WARNING: media is stored inside this deploy folder and will be lost on the next deploy. ' +
      'Set MEDIA_ROOT in .env to a folder outside it (see utils/paths.js).'
    );
  }
  console.log(
    `Videos on disk: ${fs.existsSync(VIDEOS_DIR) ? fs.readdirSync(VIDEOS_DIR).length : 0}, ` +
    `thumbnails: ${fs.existsSync(THUMBS_DIR) ? fs.readdirSync(THUMBS_DIR).length : 0}`
  );
});

// Large uploads over slow links need long (or disabled) request timeouts.
server.timeout = 0; // no idle timeout
server.keepAliveTimeout = 120000;
server.headersTimeout = 120000;
server.requestTimeout = 0;