-- Video CMS schema
-- Run this once against your database (or let `npm run init-db` do it for you).

CREATE TABLE IF NOT EXISTS admins (
  id INT AUTO_INCREMENT PRIMARY KEY,
  username VARCHAR(100) NOT NULL UNIQUE,
  password_hash VARCHAR(255) NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS categories (
  id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(150) NOT NULL UNIQUE,
  slug VARCHAR(150) NOT NULL UNIQUE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS videos (
  id INT AUTO_INCREMENT PRIMARY KEY,
  title VARCHAR(255) NOT NULL,
  description TEXT,
  category_id INT NULL,
  video_filename VARCHAR(255) NOT NULL,       -- final optimized MP4 on disk ('' if HLS only)
  hls_path VARCHAR(64) NULL,                  -- folder under public/media/hls/ (adaptive stream)
  renditions VARCHAR(100) NULL,               -- e.g. 1080p,720p,480p,360p
  original_filename VARCHAR(255) NOT NULL,    -- filename as uploaded
  source_tmp VARCHAR(255) NULL,               -- temp upload, kept until conversion finishes
  thumbnail_tmp VARCHAR(255) NULL,
  thumbnail_filename VARCHAR(255),
  duration_seconds FLOAT,
  width INT,
  height INT,
  file_size_bytes BIGINT,
  status ENUM('processing', 'ready', 'failed') NOT NULL DEFAULT 'processing',
  progress TINYINT UNSIGNED NOT NULL DEFAULT 0, -- conversion progress 0-100
  error_message VARCHAR(500),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (category_id) REFERENCES categories(id) ON DELETE SET NULL,
  INDEX idx_status (status),
  INDEX idx_category (category_id),
  INDEX idx_created (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
