/**
 * Adds the adaptive-streaming columns to an existing `videos` table.
 * Safe to run on every start: it only adds columns that are missing.
 * (Fresh installs already get them from sql/schema.sql.)
 */
const HLS_COLUMNS = [
  ['subcategory_id', 'INT NULL AFTER category_id'],
  // folder name under public/media/hls/ (NULL = no HLS, e.g. older MP4-only videos)
  ['hls_path', 'VARCHAR(64) NULL AFTER video_filename'],
  // e.g. "1080p,720p,480p,360p"
  ['renditions', 'VARCHAR(100) NULL AFTER hls_path'],
  // conversion progress 0-100, shown on the upload page
  ['progress', 'TINYINT UNSIGNED NOT NULL DEFAULT 0 AFTER status'],
  // temp upload file names, so a conversion can resume after a server restart
  ['source_tmp', 'VARCHAR(255) NULL AFTER original_filename'],
  ['thumbnail_tmp', 'VARCHAR(255) NULL AFTER source_tmp'],
];

async function ensureVideoColumns(db) {
  // Ensure subcategories table exists
  await db.query(`
    CREATE TABLE IF NOT EXISTS subcategories (
      id INT AUTO_INCREMENT PRIMARY KEY,
      category_id INT NOT NULL,
      name VARCHAR(150) NOT NULL,
      slug VARCHAR(150) NOT NULL UNIQUE,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (category_id) REFERENCES categories(id) ON DELETE CASCADE,
      INDEX idx_subcategory_category (category_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  const [rows] = await db.query(
    `SELECT COLUMN_NAME FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'videos'`
  );
  if (rows.length === 0) return; // table not created yet - run `npm run init-db`
  const existing = new Set(rows.map((r) => r.COLUMN_NAME));
  for (const [name, definition] of HLS_COLUMNS) {
    if (!existing.has(name)) {
      await db.query(`ALTER TABLE videos ADD COLUMN ${name} ${definition}`);
      console.log(`[schema] added videos.${name}`);
    }
  }
}

module.exports = { ensureVideoColumns };
