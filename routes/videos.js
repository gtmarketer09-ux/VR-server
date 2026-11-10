const express = require('express');
const path = require('path');
const fs = require('fs');
const db = require('../config/db');
const { requireAuth } = require('../middleware/auth');
const { upload } = require('../utils/upload');
const {
  safeUnlink,
  VIDEOS_DIR,
  THUMBS_DIR,
  HLS_DIR,
} = require('../utils/videoProcessor');
const videoQueue = require('../utils/videoQueue');

const router = express.Router();
// Trim trailing slash. Empty = relative URLs (/media/...), which is the safest
// option behind HTTPS reverse proxies (Hostinger, nginx) — avoids mixed-content
// breakage when PUBLIC_BASE_URL is left as http://localhost:8080 in production.
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, '');

function mediaUrl(relativePath) {
  return PUBLIC_BASE_URL ? `${PUBLIC_BASE_URL}${relativePath}` : relativePath;
}

function toPublicShape(row) {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    category: row.category_name
      ? { id: row.category_id, name: row.category_name, slug: row.category_slug }
      : null,
    thumbnail_url: row.thumbnail_filename
      ? mediaUrl(`/media/thumbnails/${row.thumbnail_filename}`)
      : null,
    // Adaptive stream (auto quality by bandwidth + manual 1080p/720p/480p/360p).
    // Null for videos uploaded before HLS was added - those still have video_url.
    hls_url: row.status === 'ready' && row.hls_path
      ? mediaUrl(`/media/hls/${row.hls_path}/master.m3u8`)
      : null,
    // Single MP4 (kept for apps/players that don't support HLS).
    video_url: row.status === 'ready' && row.video_filename
      ? mediaUrl(`/media/videos/${row.video_filename}`)
      : null,
    renditions: row.renditions ? row.renditions.split(',') : [],
    progress: row.progress ?? null,
    duration_seconds: row.duration_seconds,
    width: row.width,
    height: row.height,
    status: row.status,
    error_message: row.error_message || null,
    created_at: row.created_at,
  };
}

// Conversion runs in utils/videoQueue.js after the HTTP response is sent.
// The row starts as 'processing' (progress 0-100) and flips to 'ready'/'failed';
// the upload page polls for that.

// Paginated JSON listing - this is the authenticated "view all videos" endpoint.
router.get('/', requireAuth, async (req, res) => {
  const page = Math.max(parseInt(req.query.page) || 1, 1);
  const limit = Math.min(Math.max(parseInt(req.query.limit) || 24, 1), 100);
  const offset = (page - 1) * limit;
  const categoryId = req.query.category_id ? parseInt(req.query.category_id) : null;

  try {
    const where = categoryId ? 'WHERE v.category_id = ?' : '';
    const params = categoryId ? [categoryId] : [];

    const [rows] = await db.query(
      `SELECT v.*, c.name AS category_name, c.slug AS category_slug
       FROM videos v
       LEFT JOIN categories c ON c.id = v.category_id
       ${where}
       ORDER BY v.created_at DESC
       LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    );

    const [[{ total }]] = await db.query(
      `SELECT COUNT(*) AS total FROM videos v ${where}`,
      params
    );

    res.json({
      data: rows.map(toPublicShape),
      pagination: { page, limit, total, total_pages: Math.ceil(total / limit) },
    });
  } catch (err) {
    console.error('Failed to list videos:', err);
    res.status(500).json({ error: 'Could not load videos' });
  }
});

router.post(
  '/',
  requireAuth,
  (req, res, next) => {
    upload.fields([{ name: 'video', maxCount: 1 }, { name: 'thumbnail', maxCount: 1 }])(req, res, (err) => {
      if (!err) return next();
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(413).json({ error: 'File too large (max 5GB per file)' });
      }
      return res.status(400).json({ error: err.message || 'Upload rejected' });
    });
  },
  async (req, res) => {
    const { title, description, category_id } = req.body;
    const videoFile = req.files?.video?.[0];
    const thumbnailFile = req.files?.thumbnail?.[0];

    if (!title || !title.trim()) {
      if (videoFile) safeUnlink(videoFile.path);
      if (thumbnailFile) safeUnlink(thumbnailFile.path);
      return res.status(400).json({ error: 'Title is required' });
    }
    if (!videoFile) {
      return res.status(400).json({ error: 'A video file (.mp4, .webm or .mov) is required' });
    }

    try {
      const [result] = await db.query(
        `INSERT INTO videos
           (title, description, category_id, video_filename, original_filename,
            source_tmp, thumbnail_tmp, status, progress)
         VALUES (?, ?, ?, '', ?, ?, ?, 'processing', 0)`,
        [
          title.trim(),
          description || null,
          category_id || null,
          videoFile.originalname,
          path.basename(videoFile.path),
          thumbnailFile ? path.basename(thumbnailFile.path) : null,
        ]
      );

      // Respond immediately - transcoding runs after the response, tracked via status polling.
      res.status(202).json({ id: result.insertId, status: 'processing' });

      videoQueue.enqueue({
        videoId: result.insertId,
        sourcePath: videoFile.path,
        thumbnailSourcePath: thumbnailFile?.path,
      });
    } catch (err) {
      console.error('Failed to create video record:', err);
      safeUnlink(videoFile.path);
      if (thumbnailFile) safeUnlink(thumbnailFile.path);
      res.status(500).json({ error: 'Could not save video' });
    }
  }
);

function unlinkMediaBestEffort(label, filePath) {
  if (!filePath) return;
  try {
    if (!fs.existsSync(filePath)) {
      console.warn(`Delete ${label}: already missing on disk (${filePath})`);
      return;
    }
    fs.unlinkSync(filePath);
  } catch (err) {
    console.warn(`Delete ${label}: could not remove ${filePath}:`, err.message);
  }
}

router.delete('/:id', requireAuth, async (req, res) => {
  try {
    const [rows] = await db.query('SELECT * FROM videos WHERE id = ?', [req.params.id]);
    const video = rows[0];
    if (!video) return res.status(404).json({ error: 'Video not found' });

    if (video.video_filename) {
      unlinkMediaBestEffort('video', path.join(VIDEOS_DIR, video.video_filename));
    }
    if (video.thumbnail_filename) {
      unlinkMediaBestEffort('thumbnail', path.join(THUMBS_DIR, video.thumbnail_filename));
    }
    if (video.hls_path) {
      try {
        fs.rmSync(path.join(HLS_DIR, path.basename(video.hls_path)), { recursive: true, force: true });
      } catch (err) {
        console.warn(`Delete hls: could not remove ${video.hls_path}:`, err.message);
      }
    }
    // Still converting? The queue sees the row is gone and cleans up its own output.

    await db.query('DELETE FROM videos WHERE id = ?', [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    console.error('Failed to delete video:', err);
    res.status(500).json({ error: 'Could not delete video' });
  }
});

module.exports = router;
