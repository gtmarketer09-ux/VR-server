/**
 * One-time (re-runnable) job: create adaptive HLS for videos uploaded before
 * HLS was added. Their MP4 keeps working the whole time; when a video's HLS
 * is done, the player switches to it automatically.
 *
 *   npm run convert-existing            # all videos without HLS
 *   npm run convert-existing -- 12 15   # only video ids 12 and 15
 *
 * Runs one video at a time. It's safe to stop (Ctrl+C) and run again later.
 */
require('dotenv').config();
const path = require('path');
const fs = require('fs');
const db = require('../config/db');
const { VIDEOS_DIR, HLS_DIR } = require('../utils/paths');
const { ensureVideoColumns } = require('../utils/schema');
const { transcodeToHls } = require('../utils/hlsTranscoder');

async function run() {
  await ensureVideoColumns(db);
  const ids = process.argv.slice(2).map(Number).filter(Boolean);

  const [rows] = await db.query(
    `SELECT id, title, video_filename FROM videos
     WHERE status = 'ready' AND hls_path IS NULL AND video_filename <> ''
     ${ids.length ? 'AND id IN (?)' : ''}
     ORDER BY id`,
    ids.length ? [ids] : []
  );
  console.log(`${rows.length} video(s) to convert`);

  let ok = 0;
  for (const [i, v] of rows.entries()) {
    const source = path.join(VIDEOS_DIR, v.video_filename);
    if (!fs.existsSync(source)) {
      console.warn(`#${v.id} skipped: ${v.video_filename} is missing on disk`);
      continue;
    }
    const name = path.parse(v.video_filename).name;
    const label = `[${i + 1}/${rows.length}] #${v.id} "${v.title}"`;
    try {
      let last = -10;
      const result = await transcodeToHls(source, path.join(HLS_DIR, name), (pct) => {
        if (pct - last >= 10) { last = pct; process.stdout.write(`\r${label} ${pct}%   `); }
      });
      await db.query('UPDATE videos SET hls_path = ?, renditions = ? WHERE id = ?', [
        name, result.renditions.join(','), v.id,
      ]);
      ok++;
      console.log(`\r${label} done (${result.renditions.join(', ')})`);
    } catch (err) {
      fs.rmSync(path.join(HLS_DIR, name), { recursive: true, force: true });
      console.error(`\r${label} failed: ${err.message}`);
    }
  }
  console.log(`Finished: ${ok}/${rows.length} converted.`);
  process.exit(0);
}

run().catch((err) => {
  console.error('Conversion failed:', err);
  process.exit(1);
});
