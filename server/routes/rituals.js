/**
 * /api/rituals — plan step 27.
 *
 *   GET    /api/rituals              the day's state for the authenticated pair
 *   POST   /api/rituals/puzzle       seal today's answer and store the envelope
 *   PUT    /api/rituals/ledger       store the sealed ritual ledger
 *
 * What this router will not do, on purpose:
 *
 *   - It never grades. There is no answer key here to grade against: the puzzle
 *     is derived from the pair key and the UTC day by a seeded PRNG that runs in
 *     the browser, so the only place the correct answer exists is the client.
 *   - It never reveals early. A peer's envelope is withheld until BOTH sides
 *     have submitted, and the response for an unrevealed day contains no
 *     envelope for the peer at all — not a length, not a timestamp.
 *   - It never accepts a pair key from the body. `pair_key` is derived from the
 *     caller's own `pairs` row, so there is no request shape that reaches
 *     another pair's data.
 */

const express = require('express');
const { authenticateToken, checkStr } = require('../lib/auth');
const ritualRepo = require('../repos/rituals');

/**
 * Structural validation of a letter envelope.
 *
 * Beyond shape, this checks the one thing the server can meaningfully verify
 * without decrypting: that the envelope carries a wrapped content key for the
 * *partner*. An answer you cannot open is not a shared answer, and accepting it
 * would produce a ritual where one person waits forever for a reveal that can
 * never be read.
 */
function parseEnvelope(raw, { partnerId }) {
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    return { error: 'The answer was not a readable envelope.' };
  }
  if (!value || typeof value !== 'object') return { error: 'The answer was not a readable envelope.' };

  const { v, ct, iv, keys, senderId, recipientId, sentAt } = value;
  if (typeof v !== 'number' || typeof ct !== 'string' || ct.length < 1) {
    return { error: 'The answer was not a sealed envelope.' };
  }
  if (typeof iv !== 'string' || iv.length < 1) return { error: 'The envelope had no initialisation vector.' };
  if (typeof sentAt !== 'string' || Number.isNaN(Date.parse(sentAt))) {
    return { error: 'The envelope had no valid timestamp.' };
  }
  if (!keys || typeof keys !== 'object') return { error: 'The envelope carried no content key.' };
  if (!Number.isInteger(senderId) || !Number.isInteger(recipientId)) {
    return { error: 'The envelope was not addressed.' };
  }
  if (senderId !== recipientId) {
    const partners = [senderId, recipientId].map(String);
    if (!partners.includes(String(partnerId))) {
      return { error: 'That envelope is addressed to someone you are not paired with.' };
    }
  }
  if (typeof keys[String(partnerId)] !== 'string' || keys[String(partnerId)].length < 1) {
    return { error: 'That answer could not be opened by your partner, so it was not stored.' };
  }
  return { value };
}

module.exports = function ritualRoutes() {
  const r = express.Router();
  const { getDb } = require('../db');
  const repo = ritualRepo(getDb());
  repo.ensureSchema();

  const DAY = /^\d{4}-\d{2}-\d{2}$/;

  r.use(authenticateToken);

  r.get('/', (req, res) => {
    const { pairKey, userId, partnerId, pairedAt } = repo.pairKeyFor(req.user.id) ?? {};
    if (!pairKey) {
      // Not an error state — it is the first thing the page has to say. There is
      // simply no pair to run a ritual for.
      return res.json({ paired: false, today: repo._internals.today() });
    }

    const accepted = repo._internals.acceptedDays();
    const requested = typeof req.query.day === 'string' ? req.query.day : '';
    // Default to today; allow yesterday so a reply that lands just after UTC
    // midnight is still filed under the day its author was actually answering.
    const day = DAY.test(requested) && accepted.has(requested) ? requested : repo._internals.today();

    const partner = getDb()
      .prepare('SELECT id, username, friendly_name FROM users WHERE id = ?')
      .get(partnerId);

    const { days, firstLetterAt } = repo.letterDays(pairKey, userId, partnerId);
    const { byUser, both } = repo.puzzle(pairKey, day);
    const mine = byUser.get(userId) ?? null;
    const theirs = byUser.get(partnerId) ?? null;
    const ledger = repo.getLedger(pairKey, userId);

    const submission = (row) => (row ? { encryptedAnswer: row.encrypted_answer, submittedAt: row.created_at } : null);

    res.json({
      paired: true,
      today: repo._internals.today(),
      day,
      pairKey,
      partner,
      letters: { days, pairedAt, firstLetterAt },
      puzzle: {
        day,
        revealed: both,
        mine: submission(mine),
        // Withheld until both sides are in. An unrevealed day reports `false`
        // and nothing else about the peer.
        theirs: both ? submission(theirs) : null,
        theirPending: !both && Boolean(theirs),
      },
      ledger: ledger ? { encryptedState: ledger.encrypted_state, updatedAt: ledger.updated_at } : null,
    });
  });

  r.post('/puzzle', (req, res) => {
    const pair = repo.pairKeyFor(req.user.id);
    if (!pair) return res.status(409).json({ error: 'You are not paired with anyone yet.' });

    const { day, encryptedAnswer } = req.body || {};
    if (!DAY.test(String(day ?? ''))) {
      return res.status(400).json({ error: 'day must be a calendar date, written YYYY-MM-DD.' });
    }
    if (!repo._internals.acceptedDays().has(day)) {
      return res
        .status(400)
        .json({ error: 'The puzzle for that day has closed. The current one is open now.' });
    }
    const bad = checkStr(encryptedAnswer, { required: true, min: 1, max: 200000 });
    if (bad) return res.status(400).json({ error: `Invalid answer: ${bad}` });

    const parsed = parseEnvelope(encryptedAnswer, { partnerId: pair.partnerId });
    if (parsed.error) return res.status(400).json({ error: parsed.error });

    repo.putPuzzleAnswer(pair.pairKey, day, req.user.id, encryptedAnswer);
    const { byUser, both } = repo.puzzle(pair.pairKey, day);

    const submission = (row) =>
      row ? { encryptedAnswer: row.encrypted_answer, submittedAt: row.created_at } : null;

    res.json({
      saved: true,
      revealed: both,
      mine: submission(byUser.get(req.user.id)),
      theirs: both ? submission(byUser.get(pair.partnerId)) : null,
      theirPending: !both && Boolean(byUser.get(pair.partnerId)),
    });
  });

  r.put('/ledger', (req, res) => {
    const pair = repo.pairKeyFor(req.user.id);
    if (!pair) return res.status(409).json({ error: 'You are not paired with anyone yet.' });

    const { encryptedState } = req.body || {};
    const bad = checkStr(encryptedState, { required: true, min: 1, max: 200000 });
    if (bad) return res.status(400).json({ error: `Invalid ritual state: ${bad}` });

    const parsed = parseEnvelope(encryptedState, { partnerId: pair.partnerId });
    if (parsed.error) return res.status(400).json({ error: parsed.error });

    const row = repo.putLedger(pair.pairKey, req.user.id, encryptedState);
    res.json({ saved: true, updatedAt: row.updated_at });
  });

  return r;
};