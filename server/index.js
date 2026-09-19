require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const { initDB, getDb, resetDB, closeDB } = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;
const isProd = process.env.NODE_ENV === 'production';
const JWT_SECRET = process.env.JWT_SECRET;
const DEFAULT_SECRETS = ['change-this-secret', 'change-this-to-a-secure-random-secret'];

if (!JWT_SECRET || DEFAULT_SECRETS.includes(JWT_SECRET)) {
  const msg = 'JWT_SECRET must be set to a non-default value';
  if (isProd) {
    console.error(JSON.stringify({ t: new Date().toISOString(), level: 'fatal', msg }));
    process.exit(1);
  } else {
    console.warn(JSON.stringify({ t: new Date().toISOString(), level: 'warn', msg: `${msg} (dev fallback in use)` }));
  }
}
const SECRET = JWT_SECRET && !DEFAULT_SECRETS.includes(JWT_SECRET) ? JWT_SECRET : 'dev-only-insecure-secret';

const log = (msg, extra = {}) => console.log(JSON.stringify({ t: new Date().toISOString(), msg, ...extra }));

app.use(helmet());
const corsOrigin = process.env.CORS_ORIGIN ? process.env.CORS_ORIGIN.split(',') : (isProd ? false : true);
app.use(cors({ origin: corsOrigin }));
app.use(express.json({ limit: '1mb' }));
app.use(express.static('public'));

const uploadsDir = path.join(__dirname, '../uploads');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });
app.use('/uploads', express.static(uploadsDir, { setHeaders: (res) => res.setHeader('X-Content-Type-Options', 'nosniff') }));

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadsDir),
  filename: (req, file, cb) => cb(null, `${uuidv4()}${path.extname(file.originalname)}`)
});
const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype && file.mimetype.startsWith('image/')) return cb(null, true);
    cb(new Error('Only image uploads are allowed'));
  }
});

const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 30, standardHeaders: true, legacyHeaders: false });
app.use('/api/login', authLimiter);
app.use('/api/signup', authLimiter);

function generatePID() {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}

// Manual validation (no new deps): returns error string or null
function checkStr(v, { required = false, min = 0, max = 1024 } = {}) {
  if (v === undefined || v === null) return required ? 'missing required field' : null;
  if (typeof v !== 'string') return 'must be a string';
  if (v.length < min) return `must be at least ${min} chars`;
  if (v.length > max) return `must be at most ${max} chars`;
  return null;
}

// DB is synchronous (better-sqlite3); init once at boot.
initDB();

const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) return res.sendStatus(401);
  jwt.verify(token, SECRET, (err, user) => {
    if (err) return res.sendStatus(403);
    req.user = user;
    next();
  });
};

app.get('/healthz', (req, res) => res.status(200).json({ ok: true }));

app.post('/api/signup', async (req, res) => {
  const { username, email, password, publicKey, encryptedPrivateKey, profileData } = req.body || {};
  const bad =
    checkStr(username, { required: true, min: 1, max: 64 }) ||
    checkStr(email, { required: true, min: 3, max: 254 }) ||
    checkStr(password, { required: true, min: 8, max: 256 });
  if (bad || !email.includes('@')) return res.status(400).json({ error: `Invalid signup body: ${bad || 'email must contain @'}` });
  try {
    const hashedPassword = await bcrypt.hash(password, 10);
    const pid = generatePID();
    const friendlyName = profileData?.friendlyName || username;
    const bio = profileData?.bio || '';

    const info = getDb().prepare(`INSERT INTO users (username, email, password_hash, public_key, encrypted_private_key, pid, friendly_name, bio, profile_data)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(username, email, hashedPassword, publicKey || '', encryptedPrivateKey || '', pid, friendlyName, bio, JSON.stringify(profileData || {}));

    const token = jwt.sign({ id: info.lastInsertRowid, username, pid }, SECRET, { expiresIn: '7d' });
    res.json({ token, user: { id: info.lastInsertRowid, username, email, pid, friendly_name: friendlyName, publicKey, encryptedPrivateKey } });
  } catch (err) {
    log('Signup error', { error: err.message });
    res.status(400).json({ error: 'Username or email already exists' });
  }
});

app.post('/api/login', async (req, res) => {
  const { email, password } = req.body || {};
  const bad = checkStr(email, { required: true, min: 3, max: 254 }) || checkStr(password, { required: true, min: 1, max: 256 });
  if (bad) return res.status(400).json({ error: `Invalid login body: ${bad}` });
  try {
    const user = getDb().prepare('SELECT * FROM users WHERE email = ?').get(email);
    if (!user) return res.status(400).json({ error: 'User not found' });

    const validPassword = await bcrypt.compare(password, user.password_hash);
    if (!validPassword) return res.status(400).json({ error: 'Invalid password' });

    const token = jwt.sign({ id: user.id, username: user.username, pid: user.pid }, SECRET, { expiresIn: '7d' });
    res.json({
      token,
      user: {
        id: user.id,
        username: user.username,
        friendly_name: user.friendly_name,
        email: user.email,
        pid: user.pid,
        publicKey: user.public_key,
        encryptedPrivateKey: user.encrypted_private_key,
        age: user.age,
        birthday: user.birthday,
        favorite_food: user.favorite_food,
        bio: user.bio,
        avatar_url: user.avatar_url
      }
    });
  } catch (err) {
    log('Login error', { error: err.message });
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/me', authenticateToken, (req, res) => {
  const user = getDb().prepare('SELECT id, username, friendly_name, email, pid, public_key as publicKey, encrypted_private_key as encryptedPrivateKey, age, birthday, favorite_food, bio, avatar_url, profile_data FROM users WHERE id = ?').get(req.user.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  res.json(user);
});

app.put('/api/me', authenticateToken, (req, res) => {
  const { friendly_name, age, birthday, favorite_food, bio } = req.body || {};
  try {
    getDb().prepare(`UPDATE users SET friendly_name = COALESCE(?, friendly_name), age = COALESCE(?, age),
      birthday = COALESCE(?, birthday), favorite_food = COALESCE(?, favorite_food), bio = COALESCE(?, bio) WHERE id = ?`)
      .run(friendly_name ?? null, age ?? null, birthday ?? null, favorite_food ?? null, bio ?? null, req.user.id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Update failed' });
  }
});

function isPaired(db, aId, bId) {
  return !!db.prepare('SELECT id FROM pairs WHERE (user1_id = ? AND user2_id = ?) OR (user1_id = ? AND user2_id = ?)').get(aId, bId, bId, aId);
}

app.post('/api/pairing/request', authenticateToken, (req, res) => {
  const { targetPid } = req.body || {};
  const bad = checkStr(targetPid, { required: true, min: 1, max: 16 });
  if (bad) return res.status(400).json({ error: `Invalid pairing body: ${bad}` });
  if (targetPid === req.user.pid) return res.status(400).json({ error: 'Cannot pair with yourself' });
  try {
    const db = getDb();
    const target = db.prepare('SELECT id FROM users WHERE pid = ?').get(targetPid);
    if (!target) return res.status(404).json({ error: 'User not found' });

    const existing = db.prepare('SELECT id FROM pairings WHERE requester_id = ? AND target_pid = ? AND status = ?').get(req.user.id, targetPid, 'pending');
    if (existing) return res.status(400).json({ error: 'Request already sent' });

    db.prepare('INSERT INTO pairings (requester_id, target_pid) VALUES (?, ?)').run(req.user.id, targetPid);
    db.prepare('INSERT INTO notifications (user_id, type, title, body) VALUES (?, ?, ?, ?)')
      .run(target.id, 'pairing_request', 'New Pairing Request', `${req.user.username} wants to pair with you!`);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Could not send pairing request' });
  }
});

app.get('/api/pairing/status', authenticateToken, (req, res) => {
  const db = getDb();
  const incoming = db.prepare(`SELECT p.id, u.username, u.pid FROM pairings p JOIN users u ON p.requester_id = u.id WHERE p.target_pid = ? AND p.status = 'pending'`).all(req.user.pid);
  const outgoing = db.prepare('SELECT id, target_pid, status FROM pairings WHERE requester_id = ?').all(req.user.id);
  const currentPair = db.prepare('SELECT * FROM pairs WHERE user1_id = ? OR user2_id = ?').get(req.user.id, req.user.id);

  let partner = null;
  if (currentPair) {
    const partnerId = currentPair.user1_id === req.user.id ? currentPair.user2_id : currentPair.user1_id;
    partner = db.prepare('SELECT id, username, friendly_name, pid, public_key as publicKey, avatar_url FROM users WHERE id = ?').get(partnerId) || null;
  }

  res.json({ incoming, outgoing, partner });
});

app.post('/api/pairing/accept', authenticateToken, (req, res) => {
  const { requestId } = req.body || {};
  if (requestId === undefined || requestId === null) return res.status(400).json({ error: 'requestId is required' });
  try {
    const db = getDb();
    const request = db.prepare('SELECT * FROM pairings WHERE id = ?').get(requestId);
    if (!request || request.target_pid !== req.user.pid) return res.status(403).json({ error: 'Invalid request' });

    db.prepare('UPDATE pairings SET status = ? WHERE id = ?').run('accepted', requestId);
    db.prepare('INSERT INTO pairs (user1_id, user2_id) VALUES (?, ?)').run(request.requester_id, req.user.id);
    db.prepare('INSERT INTO notifications (user_id, type, title, body) VALUES (?, ?, ?, ?)')
      .run(request.requester_id, 'pairing_accepted', 'Pairing Accepted', `${req.user.username} accepted your pairing request!`);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Could not accept pairing' });
  }
});

app.post('/api/pairing/reject', authenticateToken, (req, res) => {
  const { requestId } = req.body || {};
  if (requestId === undefined || requestId === null) return res.status(400).json({ error: 'requestId is required' });
  try {
    const db = getDb();
    const request = db.prepare('SELECT * FROM pairings WHERE id = ?').get(requestId);
    if (!request || request.target_pid !== req.user.pid) return res.status(403).json({ error: 'Invalid request' });
    if (request.status !== 'pending') return res.status(400).json({ error: 'Request already handled' });

    db.prepare('UPDATE pairings SET status = ? WHERE id = ?').run('rejected', requestId);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Could not reject pairing' });
  }
});

app.delete('/api/pairs/unpair', authenticateToken, (req, res) => {
  try {
    getDb().prepare('DELETE FROM pairs WHERE user1_id = ? OR user2_id = ?').run(req.user.id, req.user.id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Could not unpair' });
  }
});

app.post('/api/letters/send', authenticateToken, (req, res) => {
  const { recipientId, encryptedContent, encryptedMetadata, deliveredAt } = req.body || {};
  if (!Number.isInteger(recipientId)) return res.status(400).json({ error: 'recipientId must be an integer' });
  const bad = checkStr(encryptedContent, { required: true, min: 1, max: 1000000 });
  if (bad) return res.status(400).json({ error: `Invalid letter body: ${bad}` });
  try {
    const db = getDb();
    if (!isPaired(db, req.user.id, recipientId)) return res.status(403).json({ error: 'Not paired with recipient' });

    db.prepare('INSERT INTO letters (sender_id, recipient_id, encrypted_content, encrypted_metadata, delivered_at) VALUES (?, ?, ?, ?, ?)')
      .run(req.user.id, recipientId, encryptedContent, encryptedMetadata ?? null, deliveredAt ?? null);
    db.prepare('INSERT INTO notifications (user_id, type, title, body) VALUES (?, ?, ?, ?)')
      .run(recipientId, 'letter_received', 'New Letter', `You received a new letter from ${req.user.username}!`);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Could not send letter' });
  }
});

function pageParams(req) {
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 100);
  const cursor = req.query.cursor !== undefined ? parseInt(req.query.cursor, 10) : null;
  return { limit, cursor: Number.isInteger(cursor) ? cursor : null };
}

app.get('/api/letters/sync', authenticateToken, (req, res) => {
  const { limit, cursor } = pageParams(req);
  const db = getDb();
  const letters = cursor === null
    ? db.prepare('SELECT * FROM letters WHERE sender_id = ? OR recipient_id = ? ORDER BY id ASC LIMIT ?').all(req.user.id, req.user.id, limit)
    : db.prepare('SELECT * FROM letters WHERE (sender_id = ? OR recipient_id = ?) AND id > ? ORDER BY id ASC LIMIT ?').all(req.user.id, req.user.id, cursor, limit);
  res.json(letters);
});

app.post('/api/photos/upload', authenticateToken, (req, res) => {
  upload.single('photo')(req, res, (err) => {
    if (err || !req.file) return res.status(400).json({ error: err ? err.message : 'No file uploaded' });
    try {
      const info = getDb().prepare('INSERT INTO photos (user_id, filename, filepath) VALUES (?, ?, ?)')
        .run(req.user.id, req.file.filename, `/uploads/${req.file.filename}`);
      res.json({ id: info.lastInsertRowid, url: `/uploads/${req.file.filename}` });
    } catch (e) {
      res.status(500).json({ error: 'Upload failed' });
    }
  });
});

app.get('/api/notifications', authenticateToken, (req, res) => {
  const { limit, cursor } = pageParams(req);
  const db = getDb();
  const notifications = cursor === null
    ? db.prepare('SELECT * FROM notifications WHERE user_id = ? ORDER BY id DESC LIMIT ?').all(req.user.id, limit)
    : db.prepare('SELECT * FROM notifications WHERE user_id = ? AND id < ? ORDER BY id DESC LIMIT ?').all(req.user.id, cursor, limit);
  res.json(notifications);
});

app.put('/api/notifications/read', authenticateToken, (req, res) => {
  getDb().prepare('UPDATE notifications SET read = 1 WHERE user_id = ?').run(req.user.id);
  res.json({ success: true });
});

const jellyfin = require('./jellyfin');

app.get('/api/jellyfin/libraries', authenticateToken, async (req, res) => {
  const libraries = await jellyfin.getLibraries();
  res.json(libraries);
});

app.get('/api/jellyfin/items', authenticateToken, async (req, res) => {
  const { libraryId } = req.query;
  if (!libraryId) return res.status(400).json({ error: 'libraryId is required' });
  const items = await jellyfin.getItems(libraryId);
  const itemsWithImages = items.map(item => ({
    ...item,
    imageUrl: jellyfin.getImageUrl(item.Id),
    streamUrl: item.Type === 'Audio' ? jellyfin.getStreamUrl(item.Id) : null
  }));
  res.json(itemsWithImages);
});

app.get('/api/jellyfin/status', authenticateToken, (req, res) => {
  res.json({ configured: jellyfin.isConfigured() });
});

// DB Reset: disabled in production; otherwise requires ADMIN_TOKEN. Never logged.
app.post('/api/admin/reset-db', authenticateToken, (req, res) => {
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
    log('DB reset failed', { error: err.message });
    res.status(500).json({ error: 'Failed to reset database' });
  }
});

// Multer/fileFilter errors -> 400 JSON (must be after routes)
const clientDist = path.join(__dirname, '../client/dist');
if (fs.existsSync(clientDist)) {
  app.use(express.static(clientDist));
  app.get(/^\/(?!api|uploads|healthz).*/, (req, res) => res.sendFile(path.join(clientDist, 'index.html')));
}
 // eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err) {
    const status = err instanceof multer.MulterError || /Only image/.test(err.message || '') ? 400 : 500;
    return res.status(status).json({ error: err.message || 'Upload failed' });
  }
  next();
});

let server;
function startServer() {
  log('Database initialized', { wal: true });
  server = app.listen(PORT, () => {
    log('PenPal Archive running', { port: PORT });
  });
  return server;
}

function shutdown(signal) {
  log('Shutting down', { signal });
  if (server) {
    server.close(() => {
      closeDB();
      process.exit(0);
    });
    setTimeout(() => process.exit(0), 5000).unref();
  } else {
    closeDB();
    process.exit(0);
  }
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

if (require.main === module) {
  startServer();
}

module.exports = { app, startServer, shutdown };
