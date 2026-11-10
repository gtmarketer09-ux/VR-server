/**
 * Run once: `npm run init-db`
 * Creates all tables (if not already present) and the single admin account
 * from ADMIN_USERNAME / ADMIN_PASSWORD in .env. Safe to re-run - it won't
 * duplicate the admin if one already exists.
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcrypt');
const db = require('../config/db');

async function run() {
  const schema = fs.readFileSync(path.join(__dirname, '..', 'sql', 'schema.sql'), 'utf-8');
  const statements = schema.split(';').map((s) => s.trim()).filter(Boolean);

  for (const statement of statements) {
    await db.query(statement);
  }
  console.log('✔ Tables created (or already existed).');
  // Existing installs: add the adaptive-streaming columns if they're missing.
  await require('../utils/schema').ensureVideoColumns(db);

  const username = process.env.ADMIN_USERNAME;
  const password = process.env.ADMIN_PASSWORD;
  if (!username || !password) {
    console.log('⚠ ADMIN_USERNAME / ADMIN_PASSWORD not set in .env - skipping admin creation.');
    process.exit(0);
  }

  const [existing] = await db.query('SELECT id FROM admins WHERE username = ?', [username]);
  if (existing.length > 0) {
    console.log(`✔ Admin "${username}" already exists - leaving it as is.`);
    process.exit(0);
  }

  const hash = await bcrypt.hash(password, 12);
  await db.query('INSERT INTO admins (username, password_hash) VALUES (?, ?)', [username, hash]);
  console.log(`✔ Admin account "${username}" created.`);
  process.exit(0);
}

run().catch((err) => {
  console.error('DB init failed:', err);
  process.exit(1);
});
