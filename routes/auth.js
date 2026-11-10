const express = require('express');
const bcrypt = require('bcrypt');
const db = require('../config/db');

const router = express.Router();

router.post('/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password are required' });
  }

  try {
    const [rows] = await db.query('SELECT * FROM admins WHERE username = ? LIMIT 1', [username]);
    const admin = rows[0];
    if (!admin) {
      return res.status(401).json({ error: 'Incorrect username or password' });
    }

    const matches = await bcrypt.compare(password, admin.password_hash);
    if (!matches) {
      return res.status(401).json({ error: 'Incorrect username or password' });
    }

    req.session.adminId = admin.id;
    req.session.username = admin.username;
    res.json({ id: admin.id, username: admin.username });
  } catch (err) {
    console.error('Login failed:', err);
    res.status(500).json({ error: 'Login failed. Try again.' });
  }
});

router.post('/logout', (req, res) => {
  req.session.destroy(() => {
    res.clearCookie('connect.sid');
    res.json({ ok: true });
  });
});

// Used by every protected page on load to decide: show page, or bounce to login.
router.get('/me', (req, res) => {
  if (req.session && req.session.adminId) {
    return res.json({ authenticated: true, username: req.session.username });
  }
  res.status(401).json({ authenticated: false });
});

module.exports = router;
