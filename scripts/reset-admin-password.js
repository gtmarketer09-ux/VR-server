require('dotenv').config();
const bcrypt = require('bcrypt');
const db = require('../config/db');

async function reset() {
  const username = process.env.ADMIN_USERNAME || 'admin';
  const password = process.env.ADMIN_PASSWORD || 'admin123';

  console.log(`Setting password for user: ${username} to: ${password}`);
  const hash = await bcrypt.hash(password, 12);
  
  // Update if exists, or insert if not
  const [existing] = await db.query('SELECT id FROM admins WHERE username = ?', [username]);
  if (existing.length > 0) {
    await db.query('UPDATE admins SET password_hash = ? WHERE username = ?', [hash, username]);
    console.log(`Password successfully updated for user "${username}".`);
  } else {
    await db.query('INSERT INTO admins (username, password_hash) VALUES (?, ?)', [username, hash]);
    console.log(`Admin user "${username}" created.`);
  }

  // Verify the hash matches
  const [rows] = await db.query('SELECT password_hash FROM admins WHERE username = ?', [username]);
  const isMatch = await bcrypt.compare(password, rows[0].password_hash);
  console.log(`Verification: password match is ${isMatch}`);

  process.exit(0);
}

reset().catch((err) => {
  console.error('Failed to reset admin password:', err);
  process.exit(1);
});

