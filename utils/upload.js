const multer = require('multer');
const path = require('path');
const crypto = require('crypto');
const { TMP_DIR } = require('./paths');

// video/quicktime = .mov from iPhones; everything is converted to H.264 HLS anyway.
const ALLOWED_VIDEO_TYPES = new Set(['video/mp4', 'video/webm', 'video/quicktime']);
const ALLOWED_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, TMP_DIR),
  filename: (req, file, cb) => {
    const randomName = crypto.randomBytes(16).toString('hex');
    cb(null, `${randomName}${path.extname(file.originalname).toLowerCase()}`);
  },
});

function fileFilter(req, file, cb) {
  if (file.fieldname === 'video') {
    if (!ALLOWED_VIDEO_TYPES.has(file.mimetype)) {
      return cb(new Error('Video must be .mp4, .webm or .mov'));
    }
  } else if (file.fieldname === 'thumbnail') {
    if (!ALLOWED_IMAGE_TYPES.has(file.mimetype)) {
      return cb(new Error('Thumbnail must be .jpg, .png, or .webp'));
    }
  }
  cb(null, true);
}

const upload = multer({
  storage,
  fileFilter,
  limits: {
    // Generous cap for Hostinger / large source files (was 2GB; failures often
    // appeared earlier due to proxy timeouts — app-side limit is no longer the bottleneck).
    fileSize: 5 * 1024 * 1024 * 1024, // 5GB
  },
});

module.exports = { upload, TMP_DIR };
