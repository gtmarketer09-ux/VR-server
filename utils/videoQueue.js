/**
 * Background conversion queue.
 *
 * Converting to 4 qualities keeps ffmpeg busy for roughly as long as the
 * video lasts (1-2 CPU cores). Running every upload at once would freeze a
 * small server, so jobs run TRANSCODE_CONCURRENCY at a time (default 1)
 * and the rest wait with status 'processing' and progress 0.
 *
 * If the server restarts mid-conversion, resumePending() picks the jobs
 * back up from the temp files in uploads/tmp.
 */
const path = require('path');
const fs = require('fs');
const db = require('../config/db');
const { TMP_DIR, VIDEOS_DIR, THUMBS_DIR, HLS_DIR } = require('./paths');
const { processUploadedMedia, safeUnlink } = require('./videoProcessor');

const CONCURRENCY = Math.max(1, parseInt(process.env.TRANSCODE_CONCURRENCY, 10) || 1);
const queue = [];
const queuedIds = new Set();
let running = 0;

/** @param {{videoId:number, sourcePath:string, thumbnailSourcePath?:string}} job */
function enqueue(job) {
  if (queuedIds.has(job.videoId)) return;
  queuedIds.add(job.videoId);
  queue.push(job);
  pump();
}

function pump() {
  while (running < CONCURRENCY && queue.length) {
    const job = queue.shift();
    running++;
    runJob(job)
      .catch((err) => console.error(`[videoQueue] job ${job.videoId} crashed:`, err))
      .finally(() => {
        running--;
        queuedIds.delete(job.videoId);
        pump();
      });
  }
}

async function runJob({ videoId, sourcePath, thumbnailSourcePath }) {
  try {
    // Skip if the video was deleted while it was waiting in the queue.
    const [[row]] = await db.query('SELECT id FROM videos WHERE id = ?', [videoId]);
    if (!row) return;

    let lastSaved = 0;
    const onProgress = (pct) => {
      if (pct - lastSaved < 5) return; // at most ~20 DB writes per video
      lastSaved = pct;
      db.query(`UPDATE videos SET progress = ? WHERE id = ? AND status = 'processing'`, [pct, videoId])
        .catch(() => {});
    };

    const result = await processUploadedMedia(sourcePath, thumbnailSourcePath, { onProgress });

    const [update] = await db.query(
      `UPDATE videos SET
         video_filename = ?, hls_path = ?, renditions = ?, thumbnail_filename = ?,
         duration_seconds = ?, width = ?, height = ?, file_size_bytes = ?,
         status = 'ready', progress = 100, error_message = ?,
         source_tmp = NULL, thumbnail_tmp = NULL
       WHERE id = ?`,
      [
        result.videoFilename || '',
        result.hlsName,
        result.renditions.join(',') || null,
        result.thumbnailFilename,
        result.meta.duration,
        result.meta.width,
        result.meta.height,
        result.fileSize,
        result.notes,
        videoId,
      ]
    );

    // Deleted while converting → remove the files we just made.
    if (update.affectedRows === 0) removeOutputs(result);
    else console.log(`[videoQueue] video ${videoId} ready (${result.renditions.join(', ') || 'mp4 only'})`);
  } catch (err) {
    console.error(`[videoQueue] processing failed for video ${videoId}:`, err.message);
    await db.query(
      `UPDATE videos SET status = 'failed', error_message = ?, source_tmp = NULL, thumbnail_tmp = NULL
       WHERE id = ?`,
      [String(err.message).slice(0, 500), videoId]
    ).catch(() => {});
  } finally {
    safeUnlink(sourcePath);
    safeUnlink(thumbnailSourcePath);
  }
}

function removeOutputs({ videoFilename, hlsName, thumbnailFilename }) {
  if (videoFilename) safeUnlink(path.join(VIDEOS_DIR, videoFilename));
  if (thumbnailFilename) safeUnlink(path.join(THUMBS_DIR, thumbnailFilename));
  if (hlsName) fs.rmSync(path.join(HLS_DIR, hlsName), { recursive: true, force: true });
}

/** Call once at startup: re-queue conversions interrupted by a restart. */
async function resumePending() {
  const [rows] = await db.query(
    `SELECT id, source_tmp, thumbnail_tmp FROM videos WHERE status = 'processing' ORDER BY id`
  );
  for (const row of rows) {
    const src = row.source_tmp && path.join(TMP_DIR, path.basename(row.source_tmp));
    if (src && fs.existsSync(src)) {
      const thumb = row.thumbnail_tmp && path.join(TMP_DIR, path.basename(row.thumbnail_tmp));
      await db.query('UPDATE videos SET progress = 0 WHERE id = ?', [row.id]);
      enqueue({ videoId: row.id, sourcePath: src, thumbnailSourcePath: thumb || undefined });
    } else {
      await db.query(
        `UPDATE videos SET status = 'failed',
           error_message = 'Server restarted before processing finished and the upload was lost - please re-upload'
         WHERE id = ?`,
        [row.id]
      );
    }
  }
  if (rows.length) console.log(`[videoQueue] resumed ${rows.length} unfinished video(s)`);
}

module.exports = { enqueue, resumePending, removeOutputs };
