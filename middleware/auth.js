/**
 * Guards API routes. If there's no authenticated session, respond 401
 * instead of leaking data. Pages use this indirectly via /api/auth/me
 * (see public/js/guard.js) to decide whether to redirect to login.html.
 */
function requireAuth(req, res, next) {
  if (req.session && req.session.adminId) {
    return next();
  }
  return res.status(401).json({ error: 'Not authenticated' });
}

module.exports = { requireAuth };
