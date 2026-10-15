/**
 * The notification list.
 *
 * Local, not derived: pairing requests and acceptances write rows here
 * directly. Nothing is generated on read, so this endpoint is a plain
 * descending-by-id page and the cursor is the id.
 */

const express = require('express');
const { getDb } = require('../db');

/** limit clamped to [1, 100]; cursor is the exclusive upper bound. */
function pageParams(req) {
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 100);
  const cursor = req.query.cursor !== undefined ? parseInt(req.query.cursor, 10) : null;
  return { limit, cursor: Number.isInteger(cursor) ? cursor : null };
}

module.exports = function notificationRoutes({ authenticateToken }) {
  const router = express.Router();

  router.get('/', authenticateToken, (req, res) => {
    const { limit, cursor } = pageParams(req);
    const db = getDb();
    // Newest first, so the cursor is `id < cursor`. Ascending paging over a
    // feed people scroll down would put the newest notification furthest away
    // and make new items invisible to someone already reading the list.
    const rows =
      cursor === null
        ? db
            .prepare('SELECT * FROM notifications WHERE user_id = ? ORDER BY id DESC LIMIT ?')
            .all(req.user.id, limit)
        : db
            .prepare('SELECT * FROM notifications WHERE user_id = ? AND id < ? ORDER BY id DESC LIMIT ?')
            .all(req.user.id, cursor, limit);
    res.json(rows);
  });

  /**
   * Mark everything read. There is no per-id variant on purpose: the list is a
   * notification tray, not a task queue, and "I've read them" is the only
   * question anyone asks of it.
   */
  router.put('/read', authenticateToken, (req, res) => {
    getDb().prepare('UPDATE notifications SET read = 1 WHERE user_id = ?').run(req.user.id);
    res.json({ success: true });
  });

  return router;
};
