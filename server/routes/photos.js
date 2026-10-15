/**
 * Photo upload and delivery.
 *
 * ## What this is, honestly
 *
 * Attachment photos are the ONE thing in this app that is not end-to-end
 * encrypted. The pixels are re-encoded through sharp and EXIF is stripped, but
 * they sit on disk in plaintext, behind an authenticated route. That is a
 * deliberate, recorded gap — see docs/SECURITY.md — not an oversight.
 *
 * Because there is no cryptography in front of them, the authorisation on this
 * route is the only thing standing between a photo and every other account on
 * the instance. v0.0.2 mounted the directory world-readable; the intermediate
 * version required a valid token but not much else, so *any* signed-in user who
 * learned or guessed a URL could read *anybody's* photos. For an app whose
 * entire premise is that it is between two people, that is the whole product
 * failing.
 *
 * ## The rule
 *
 *   - The uploader can always see their own photo.
 *   - The other party in the letter a photo is attached to can see it.
 *   - Nobody else can, ever, and cannot even learn that it exists.
 *
 * The middle rule needs `photos.letter_id`, which nothing populates yet — so in
 * practice every upload is private to its owner today. That is the safe default,
 * not a stub: sharing becomes possible the moment a photo is attached, and is
 * impossible until then.
 */

const express = require('express');
const multer = require('multer');
const path = require('path');
const { getDb } = require('../db');
const { photoUpload, processUpload, thumbUrlFor } = require('../uploads');

/**
 * Filenames are `<uuid>.ext` and `<uuid>_thumb.ext`, written by the pipeline.
 * Matching this shape is not decoration: it is what makes it impossible to ask
 * the filesystem for something that is not a photo, so the traversal handling
 * below is a single anchored test rather than a normalisation routine that
 * could be wrong in a new way.
 */
const FILENAME_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(_thumb)?\.[a-z0-9]{2,5}$/i;

/** The canonical `photos.filename` for a requested full or thumbnail name. */
function photoFilenameFor(requested) {
  return requested.replace(/_thumb(\.[a-z0-9]+)$/i, '$1');
}

/**
 * Can this user see this photo?
 *
 * One statement, so there is no path where the answer is assembled from parts.
 * A photo with no letter attached is visible only to whoever uploaded it.
 */
const VISIBLE_PHOTO_SQL = `
  SELECT 1 AS ok
    FROM photos p
    LEFT JOIN letters l ON l.id = p.letter_id
   WHERE p.filename = ?
     AND (
          p.user_id = ?
          OR l.sender_id = ?
          OR l.recipient_id = ?
     )
   LIMIT 1`;

/**
 * POST /api/photos/upload
 */
function uploadRoute({ authenticateToken, perUser, writeMax, uploadsDir, log }) {
  const router = express.Router();

  router.post('/upload', authenticateToken, perUser(writeMax), (req, res) => {
    photoUpload.single('photo')(req, res, async (err) => {
      if (err || !req.file) {
        const status = err instanceof multer.MulterError ? 400 : err?.status || 400;
        return res.status(status).json({ error: err ? err.message : 'No file uploaded' });
      }
      try {
        const stored = await processUpload(req.file.buffer, uploadsDir);
        const info = getDb()
          .prepare('INSERT INTO photos (user_id, filename, filepath) VALUES (?, ?, ?)')
          .run(req.user.id, stored.filename, stored.filepath);

        res.json({
          id: info.lastInsertRowid,
          url: stored.filepath,
          thumbUrl: stored.thumbFilepath || thumbUrlFor(stored.filepath),
        });
      } catch (e) {
        // Fail closed: a rejected upload never reached the disk, so there is
        // nothing to clean up here.
        if (e && e.name === 'UploadRejected') {
          return res.status(e.status || 400).json({ error: e.message });
        }
        log('Photo upload failed', { error: e && e.message });
        return res.status(500).json({ error: 'Upload failed' });
      }
    });
  });

  return router;
}

/**
 * GET /uploads/&lt;filename&gt;
 *
 * Mounted in place of express.static, because a static mount cannot ask who is
 * asking. Every file under this directory is somebody's photograph.
 */
function filesRoute({ authenticateToken, uploadsDir, log }) {
  const router = express.Router();

  router.get('/:filename', authenticateToken, (req, res) => {
    const requested = req.params.filename;

    if (!FILENAME_RE.test(requested)) {
      return res.status(404).json({ error: 'Not found' });
    }

    const filename = photoFilenameFor(requested);
    const me = req.user.id;

    const visible = getDb().prepare(VISIBLE_PHOTO_SQL).get(filename, me, me, me);
    if (!visible) {
      // 404, not 403. A 403 confirms the photo exists, which turns the upload
      // directory into an enumeration oracle: upload, vary the UUID, watch for
      // the difference between "no such photo" and "not yours". The distinction
      // is not worth the leak, so an unauthorised request looks exactly like a
      // missing file.
      log('upload denied', { user_id: me, filename });
      return res.status(404).json({ error: 'Not found' });
    }

    res.setHeader('X-Content-Type-Options', 'nosniff');
    // sendFile resolves against root and rejects a path that escapes it, but the
    // name has already been shape-checked above, so this is belt and braces.
    return res.sendFile(path.join(uploadsDir, requested), { dotfiles: 'deny' }, (err) => {
      if (err && !res.headersSent) {
        // A row in the database whose file is gone is a real operational state,
        // not a 404 from the client's point of view — the row says it exists.
        log('upload missing from disk', { filename, error: err.code });
        res.status(500).json({ error: 'Photo could not be read' });
      }
    });
  });

  return router;
}

module.exports = { uploadRoute, filesRoute, FILENAME_RE, photoFilenameFor };
