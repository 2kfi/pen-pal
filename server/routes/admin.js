/**
 * Administrative endpoints.
 *
 * Reset is the only one, it is disabled outright in production, and it requires
 * a token from the environment. There is no database browser, no query console
 * and no user impersonation here, and there should not be: this is the surface
 * where those would go, and on a self-hosted instance they would be reachable by
 * anyone who ever got hold of ADMIN_TOKEN.
 */

const express = require('express');
const { resetDB } = require('../db');

module.exports = function adminRoutes({ authenticateToken, isProd, log }) {
  const router = express.Router();

  router.post('/admin/reset-db', authenticateToken, (req, res) => {
    if (isProd) return res.status(404).json({ error: 'Not found' });

    const expected = process.env.ADMIN_TOKEN;
    if (!expected) return res.status(403).json({ error: 'Admin reset disabled' });

    const got = req.headers['x-admin-token'] || req.body?.adminToken || req.body?.code;
    if (got !== expected) return res.status(403).json({ error: 'Invalid admin token' });

    try {
      resetDB();
      log('Database has been reset');
      res.json({ success: true, message: 'Database reset successfully' });
    } catch (err) {
      // The message is logged but not returned: a reset failure is an operator
      // problem, and the client is a browser that cannot act on it anyway.
      log('DB reset failed', { error: err.message });
      res.status(500).json({ error: 'Failed to reset database' });
    }
  });

  return router;
};
