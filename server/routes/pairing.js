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

/** Every handshake row for one user, newest first. */
function allPairs(db, userId) {
  return db
    .prepare('SELECT * FROM pairs WHERE user_id = ? ORDER BY created_at DESC, rowid DESC')
    .all(userId);
}

/** One specific partnership row, or undefined. Derived from the caller's own rows. */
function pairWith(db, userId, partnerId) {
  return db
    .prepare('SELECT * FROM pairs WHERE user_id = ? AND partner_id = ?')
    .get(userId, partnerId);
}

/** The "selected" partner: the most recent partnership. Kept for one release so
 *  clients and tests written against the single-pal shape keep working; the
 *  switcher comes from `partners` below. */
function currentPair(db, userId) {
  return allPairs(db, userId)[0];
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

    const partners = allPairs(db, req.user.id).map((pair) =>
      db.prepare(
        'SELECT id, username, friendly_name, pid, public_key as publicKey, avatar_url FROM users WHERE id = ?',
      ).get(pair.partner_id) ?? pair.partner_id,
    );

    res.json({ incoming, outgoing, partners, partner: partners[0] ?? null });
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

      // Pen pals, plural. What is still refused: pairing the SAME two people
      // twice in either direction. Refusing "is either party paired at all"
      // would make the plural impossible; refusing nothing would let a
      // duplicate row through as a second channel to the same person, which is
      // how letters could get silently addressed twice. The two parties here
      // are the requester and the acceptor (`target` was addressed by pid, so
      // it IS the acceptor).
      const partnerRow = pairWith(db, req.user.id, request.requester_id);
      const reverseRow = pairWith(db, request.requester_id, req.user.id);

      if (partnerRow || reverseRow) {
        db.prepare('UPDATE pairings SET status = ? WHERE id = ?').run('superseded', requestId);
        return res
          .status(409)
          .json({ error: 'You two are already writing to each other.' });
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
   * One partnership per call, addressed by `partnerId`. Both rows of THAT
   * partnership go together so the two sides can never disagree about whether
   * they are still paired. Deleting only the caller's row would leave the
   * partner pointing at someone who has moved on, and their next letter would
   * be addressed to a stranger.
   *
   * A body without `partnerId` is accepted only while the caller has exactly
   * one partnership — the single-pal client shape. A person with several pals
   * must say who ends; "unpair everyone" is not a sentence this endpoint knows.
   *
   * Letters already sent are NOT deleted. Unpairing closes the channel going
   * forward; it is not a way to unsay something, and quietly erasing a person's
   * letters because they reparied would be unforgivable.
   */
  router.delete('/pairs/unpair', authenticateToken, (req, res) => {
    const { partnerId } = req.body || {};
    try {
      const db = getDb();
      const mine = allPairs(db, req.user.id);
      let partner_id;
      if (partnerId === undefined || partnerId === null || partnerId === '') {
        if (mine.length !== 1) {
          return res
            .status(400)
            .json({ error: 'partnerId is required when you have more than one pen pal' });
        }
        partner_id = mine[0].partner_id;
      } else {
        const asked = Number(partnerId);
        if (!Number.isInteger(asked)) return res.status(400).json({ error: 'partnerId must be a user id' });
        if (!mine.some((p) => p.partner_id === asked)) {
          return res.status(403).json({ error: 'That person is not your pen pal' });
        }
        partner_id = asked;
      }

      getDb()
        .prepare(
          'DELETE FROM pairs WHERE (user_id = :me AND partner_id = :them) OR (user_id = :them AND partner_id = :me)',
        )
        .run({ me: req.user.id, them: partner_id });
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
module.exports.allPairs = allPairs;
module.exports.pairWith = pairWith;
