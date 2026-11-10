const express = require('express');
const db = require('../config/db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

function slugify(name) {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');
}

// List all categories (with a live video count, useful for the upload page's dropdown + management page)
router.get('/', requireAuth, async (req, res) => {
  try {
    const [rows] = await db.query(`
      SELECT c.id, c.name, c.slug, c.created_at,
             COUNT(v.id) AS video_count
      FROM categories c
      LEFT JOIN videos v ON v.category_id = c.id
      GROUP BY c.id
      ORDER BY c.name ASC
    `);
    res.json(rows);
  } catch (err) {
    console.error('Failed to list categories:', err);
    res.status(500).json({ error: 'Could not load categories' });
  }
});

router.post('/', requireAuth, async (req, res) => {
  const { name } = req.body;
  if (!name || !name.trim()) {
    return res.status(400).json({ error: 'Category name is required' });
  }
  const slug = slugify(name);
  try {
    const [result] = await db.query(
      'INSERT INTO categories (name, slug) VALUES (?, ?)',
      [name.trim(), slug]
    );
    res.status(201).json({ id: result.insertId, name: name.trim(), slug, video_count: 0 });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({ error: 'A category with that name already exists' });
    }
    console.error('Failed to create category:', err);
    res.status(500).json({ error: 'Could not create category' });
  }
});

router.delete('/:id', requireAuth, async (req, res) => {
  try {
    // Videos in this category are kept; their category_id just becomes NULL (ON DELETE SET NULL).
    await db.query('DELETE FROM categories WHERE id = ?', [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    console.error('Failed to delete category:', err);
    res.status(500).json({ error: 'Could not delete category' });
  }
});

module.exports = router;
