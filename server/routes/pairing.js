/**
 * Pairing — the moment two accounts become one channel.
 *
 * The whole product rests on this file, so the rules are stated rather than
 * implied. A pair is stored as TWO rows in `pairs`, one per user, because
 * `user_id` is the PRIMARY KEY: a single row per pair would need a unique index
 * across two columns to stop somebody appearing twice.
 *
 * Everything that reads a letter later resolves "who is my partner" through this
 * table, so a mistake here does not produce an error — it produces a letter
 * addressed to whoever the lookup happened to surface.
 */

const express = require('express');
const { getDb } = require('../db');
const { checkStr } = require('../lib/auth');

/** A pair is stored as one row per user, so checking one direction is sufficient —
 *  both rows are always written together inside the same transaction-ish block. */
function isPaired(db, aId, bId) {
  return !!db.prepare('SELECT user_id FROM pairs WHERE user_id = ? AND partner_id = ?').get(aId, bId);
}

/** The current partner row for a user, or undefined. */
function currentPair(db, userId) {
  return db.prepare('SELECT * FROM pairs WHERE user_id = ?').get(userId);
}

module.exports = function pairingRoutes({ authenticateToken, perUser, writeMax, log }) {
  const router = express.Router();

  /**
   * Every catch in this file logs before answering.
   *
   * The v0.0.2 handlers caught, returned a generic 500 and threw the error away.
   * A pairing bug then presented as "expected 500 to be 200" in a test with no
   * way to tell a constraint violation from a typo in a column name. The client
   * still gets a generic message — the log is for whoever is debugging at 1am.
   */
  const failed = (what, err) => {
    if (log) log('pairing failed', { what, error: err && err.message });
    else console.error(JSON.stringify({ msg: 'pairing failed', what, error: err && err.message }));
  };

  router.post('/pairing/request', authenticateToken, perUser(writeMax), (req, res) => {
    const { targetPid } = req.body || {};
    const bad = checkStr(targetPid, { required: true, min: 1, max: 16 });
    if (bad) return res.status(400).json({ error: `Invalid pairing body: ${bad}` });
    if (targetPid === req.user.pid) return res.status(400).json({ error: 'Cannot pair with yourself' });

    try {
      const db = getDb();
      const target = db.prepare('SELECT id FROM users WHERE pid = ?').get(targetPid);
      if (!target) return res.status(404).json({ error: 'User not found' });

      const existing = db
        .prepare("SELECT id FROM pairings WHERE requester_id = ? AND target_pid = ? AND status = 'pending'")
        .get(req.user.id, targetPid);
      if (existing) return res.status(400).json({ error: 'Request already sent' });

      db.prepare('INSERT INTO pairings (requester_id, target_pid) VALUES (?, ?)').run(req.user.id, targetPid);
      db.prepare('INSERT INTO notifications (user_id, type, title, body) VALUES (?, ?, ?, ?)').run(
        target.id,
        'pairing_request',
        'New Pairing Request',
        `${req.user.username} wants to pair with you!`,
      );
      res.json({ success: true });
    } catch (err) {
      failed('send pairing request', err);
      res.status(500).json({ error: 'Could not send pairing request' });
    }
  });

  router.get('/pairing/status', authenticateToken, (req, res) => {
    const db = getDb();
    const incoming = db
      .prepare(
        `SELECT p.id, u.username, u.friendly_name, u.pid
           FROM pairings p JOIN users u ON p.requester_id = u.id
          WHERE p.target_pid = ? AND p.status = 'pending'`,
      )
      .all(req.user.pid);
    const outgoing = db
      .prepare('SELECT id, target_pid, status FROM pairings WHERE requester_id = ?')
      .all(req.user.id);

    let partner = null;
    const pair = currentPair(db, req.user.id);
    if (pair) {
      partner =
        db
          .prepare(
            'SELECT id, username, friendly_name, pid, public_key as publicKey, avatar_url FROM users WHERE id = ?',
          )
          .get(pair.partner_id) ?? null;
    }

    res.json({ incoming, outgoing, partner });
  });

  router.post('/pairing/accept', authenticateToken, (req, res) => {
    const { requestId } = req.body || {};
    if (requestId === undefined || requestId === null) {
      return res.status(400).json({ error: 'requestId is required' });
    }

    try {
      const db = getDb();
      // Addressed by pid, not by id: a request is a message to whoever now holds
      // that pid, and comparing against it is what stops you accepting an invite
      // that was aimed at somebody else.
      const request = db.prepare('SELECT * FROM pairings WHERE id = ?').get(requestId);
      if (!request || request.target_pid !== req.user.pid) {
        return res.status(403).json({ error: 'Invalid request' });
      }
      if (request.status !== 'pending') {
        return res.status(400).json({ error: 'This invite was already handled' });
      }

      const target = db.prepare('SELECT id FROM users WHERE pid = ?').get(request.target_pid);
      if (!target) return res.status(404).json({ error: 'User not found' });

      // One partner, at a time. The question is "is EITHER party already paired
      // with anyone", not "are these two already paired" — checking the latter
      // lets a paired user accept a second partner and then hit the pairs
      // PRIMARY KEY. v0.0.2 checked nothing, so a user could accumulate
      // unlimited pairs and the partner lookup returned an ARBITRARY one, meaning
      // Compose could silently post a letter to whichever partner surfaced first.
      const alreadyPaired = db
        .prepare('SELECT user_id FROM pairs WHERE user_id IN (?, ?) LIMIT 1')
        .get(request.requester_id, target.id);

      if (alreadyPaired) {
        db.prepare('UPDATE pairings SET status = ? WHERE id = ?').run('superseded', requestId);
        return res
          .status(409)
          .json({ error: 'One of you is already paired. Unpair before accepting someone new.' });
      }

      db.prepare('UPDATE pairings SET status = ? WHERE id = ?').run('accepted', requestId);

      // Two rows, one per user. user_id is the PRIMARY KEY, so a second pairing
      // for either party fails loudly here instead of silently accumulating.
      const insertPair = db.prepare('INSERT INTO pairs (user_id, partner_id) VALUES (?, ?)');
      insertPair.run(request.requester_id, target.id);
      insertPair.run(target.id, request.requester_id);

      db.prepare('INSERT INTO notifications (user_id, type, title, body) VALUES (?, ?, ?, ?)').run(
        request.requester_id,
        'pairing_accepted',
        'Pairing accepted',
        `${req.user.username} accepted your pairing request!`,
      );
      res.json({ success: true });
    } catch (err) {
      failed('accept pairing', err);
      res.status(500).json({ error: 'Could not accept pairing' });
    }
  });

  router.post('/pairing/reject', authenticateToken, (req, res) => {
    const { requestId } = req.body || {};
    if (requestId === undefined || requestId === null) {
      return res.status(400).json({ error: 'requestId is required' });
    }
    try {
      const db = getDb();
      const request = db.prepare('SELECT * FROM pairings WHERE id = ?').get(requestId);
      if (!request || request.target_pid !== req.user.pid) {
        return res.status(403).json({ error: 'Invalid request' });
      }
      if (request.status !== 'pending') {
        return res.status(400).json({ error: 'Request already handled' });
      }

      db.prepare('UPDATE pairings SET status = ? WHERE id = ?').run('rejected', requestId);
      res.json({ success: true });
    } catch (err) {
      failed('reject pairing', err);
      res.status(500).json({ error: 'Could not reject pairing' });
    }
  });

  /**
   * DELETE /pairs/unpair
   *
   * Both rows go together so the two sides can never disagree about whether they
   * are still paired. Deleting only the caller's row would leave the partner
   * pointing at someone who has moved on, and their next letter would be
   * addressed to a stranger.
   *
   * Letters already sent are NOT deleted. Unpairing closes the channel going
   * forward; it is not a way to unsay something, and quietly erasing a person's
   * letters because they reparied would be unforgivable.
   */
  router.delete('/pairs/unpair', authenticateToken, (req, res) => {
    try {
      getDb()
        .prepare('DELETE FROM pairs WHERE user_id = ? OR partner_id = ?')
        .run(req.user.id, req.user.id);
      res.json({ success: true });
    } catch (err) {
      failed('unpair', err);
      res.status(500).json({ error: 'Could not unpair' });
    }
  });

  return router;
};

module.exports.isPaired = isPaired;
module.exports.currentPair = currentPair;
