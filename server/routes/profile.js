/**
 * The signed-in user's own profile.
 *
 * Read and write only — there is no route here that fetches somebody else's
 * profile by id, because there is no product reason for one. A pen pal's public
 * details arrive through /api/pairing/status.
 */

const express = require('express');
const { getDb } = require('../db');

const PROFILE_COLUMNS = `id, username, friendly_name, email, pid,
  public_key as publicKey, encrypted_private_key as encryptedPrivateKey,
  age, birthday, favorite_food, bio, avatar_url, profile_data`;

module.exports = function profileRoutes({ authenticateToken }) {
  const router = express.Router();

  router.get('/me', authenticateToken, (req, res) => {
    const user = getDb().prepare(`SELECT ${PROFILE_COLUMNS} FROM users WHERE id = ?`).get(req.user.id);
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json(user);
  });

  /**
   * Partial update.
   *
   * COALESCE means an absent field keeps its current value, so a client that
   * sends only `bio` does not blank the user's birthday. The trade-off is that a
   * field cannot be cleared by omitting it — sending an explicit null does it,
   * and the client does that.
   */
  router.put('/me', authenticateToken, (req, res) => {
    const { friendly_name, age, birthday, favorite_food, bio } = req.body || {};
    try {
      getDb()
        .prepare(
          `UPDATE users SET
             friendly_name  = COALESCE(?, friendly_name),
             age            = COALESCE(?, age),
             birthday       = COALESCE(?, birthday),
             favorite_food  = COALESCE(?, favorite_food),
             bio            = COALESCE(?, bio)
           WHERE id = ?`,
        )
        .run(
          friendly_name ?? null,
          age ?? null,
          birthday ?? null,
          favorite_food ?? null,
          bio ?? null,
          req.user.id,
        );
      res.json({ success: true });
    } catch {
      // Deliberately not echoed to the client: the message would name a column,
      // which is a free schema hint for anyone who can get here.
      res.status(500).json({ error: 'Update failed' });
    }
  });

  return router;
};
