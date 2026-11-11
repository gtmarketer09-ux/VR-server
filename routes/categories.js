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

// List all categories with nested subcategories and video counts
router.get('/', requireAuth, async (req, res) => {
  try {
    const [categories] = await db.query(`
      SELECT c.id, c.name, c.slug, c.created_at,
             COUNT(DISTINCT v.id) AS video_count
      FROM categories c
      LEFT JOIN videos v ON v.category_id = c.id
      GROUP BY c.id
      ORDER BY c.name ASC
    `);

    const [subcategories] = await db.query(`
      SELECT s.id, s.category_id, s.name, s.slug, s.created_at,
             COUNT(DISTINCT v.id) AS video_count
      FROM subcategories s
      LEFT JOIN videos v ON v.subcategory_id = s.id
      GROUP BY s.id
      ORDER BY s.name ASC
    `);

    const subcatMap = new Map();
    for (const sub of subcategories) {
      if (!subcatMap.has(sub.category_id)) {
        subcatMap.set(sub.category_id, []);
      }
      subcatMap.get(sub.category_id).push(sub);
    }

    for (const cat of categories) {
      cat.subcategories = subcatMap.get(cat.id) || [];
    }

    res.json(categories);
  } catch (err) {
    console.error('Failed to list categories:', err);
    res.status(500).json({ error: 'Could not load categories' });
  }
});

// Create category
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
    res.status(201).json({ id: result.insertId, name: name.trim(), slug, video_count: 0, subcategories: [] });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({ error: 'A category with that name already exists' });
    }
    console.error('Failed to create category:', err);
    res.status(500).json({ error: 'Could not create category' });
  }
});

// Delete category
router.delete('/:id', requireAuth, async (req, res) => {
  try {
    // Videos in this category are kept; their category_id becomes NULL (ON DELETE SET NULL).
    await db.query('DELETE FROM categories WHERE id = ?', [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    console.error('Failed to delete category:', err);
    res.status(500).json({ error: 'Could not delete category' });
  }
});

// Create subcategory
router.post('/subcategories', requireAuth, async (req, res) => {
  const { category_id, name } = req.body;
  if (!category_id) {
    return res.status(400).json({ error: 'Parent category is required' });
  }
  if (!name || !name.trim()) {
    return res.status(400).json({ error: 'Subcategory name is required' });
  }

  const baseSlug = slugify(name);
  let slug = baseSlug;

  try {
    // Verify parent category exists
    const [cat] = await db.query('SELECT id FROM categories WHERE id = ?', [category_id]);
    if (cat.length === 0) {
      return res.status(404).json({ error: 'Parent category not found' });
    }

    // Check if slug is taken; if so, append category id
    const [existingSlug] = await db.query('SELECT id FROM subcategories WHERE slug = ?', [slug]);
    if (existingSlug.length > 0) {
      slug = `${baseSlug}-${category_id}`;
    }

    const [result] = await db.query(
      'INSERT INTO subcategories (category_id, name, slug) VALUES (?, ?, ?)',
      [category_id, name.trim(), slug]
    );

    res.status(201).json({
      id: result.insertId,
      category_id: parseInt(category_id),
      name: name.trim(),
      slug,
      video_count: 0,
    });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({ error: 'A subcategory with that name/slug already exists' });
    }
    console.error('Failed to create subcategory:', err);
    res.status(500).json({ error: 'Could not create subcategory' });
  }
});

// Delete subcategory
router.delete('/subcategories/:id', requireAuth, async (req, res) => {
  try {
    await db.query('DELETE FROM subcategories WHERE id = ?', [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    console.error('Failed to delete subcategory:', err);
    res.status(500).json({ error: 'Could not delete subcategory' });
  }
});

module.exports = router;
