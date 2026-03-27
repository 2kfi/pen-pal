require('dotenv').config();
const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const initSqlJs = require('sql.js');
const { v4: uuidv4 } = require('uuid');

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'change-this-secret';

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.static('public'));

const uploadsDir = path.join(__dirname, '../uploads');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });
app.use('/uploads', express.static(uploadsDir));

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadsDir),
  filename: (req, file, cb) => cb(null, `${uuidv4()}${path.extname(file.originalname)}`)
});
const upload = multer({ storage, limits: { fileSize: 10 * 1024 * 1024 } });

function generatePID() {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}

const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) return res.sendStatus(401);
  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) return res.sendStatus(403);
    req.user = user;
    next();
  });
};

let db;

async function initDB() {
  const SQL = await initSqlJs();
  const dbPath = path.join(__dirname, '../data/penpal.db');
  
  let data = null;
  if (fs.existsSync(dbPath)) {
    data = fs.readFileSync(dbPath);
  }
  
  db = new SQL.Database(data);
  
  db.run(`CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT UNIQUE NOT NULL, friendly_name TEXT,
    email TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL, public_key TEXT,
    encrypted_private_key TEXT, pid TEXT UNIQUE NOT NULL, age INTEGER, birthday TEXT,
    favorite_food TEXT, bio TEXT DEFAULT '', avatar_url TEXT, profile_data TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP)`);
    
  db.run(`CREATE TABLE IF NOT EXISTS pairs (
    id INTEGER PRIMARY KEY AUTOINCREMENT, user1_id INTEGER NOT NULL, user2_id INTEGER NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP)`);
    
  db.run(`CREATE TABLE IF NOT EXISTS letters (
    id INTEGER PRIMARY KEY AUTOINCREMENT, sender_id INTEGER NOT NULL, recipient_id INTEGER NOT NULL,
    encrypted_content TEXT NOT NULL, encrypted_metadata TEXT, photo_paths TEXT,
    sent_at DATETIME DEFAULT CURRENT_TIMESTAMP, delivered_at DATETIME, sync_version INTEGER DEFAULT 0)`);
    
  db.run(`CREATE TABLE IF NOT EXISTS pairings (
    id INTEGER PRIMARY KEY AUTOINCREMENT, requester_id INTEGER NOT NULL, target_pid TEXT NOT NULL,
    status TEXT DEFAULT 'pending', created_at DATETIME DEFAULT CURRENT_TIMESTAMP)`);
    
  db.run(`CREATE TABLE IF NOT EXISTS notifications (
    id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, type TEXT NOT NULL,
    title TEXT NOT NULL, body TEXT, read INTEGER DEFAULT 0, created_at DATETIME DEFAULT CURRENT_TIMESTAMP)`);
    
  db.run(`CREATE TABLE IF NOT EXISTS photos (
    id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, letter_id INTEGER,
    filename TEXT NOT NULL, filepath TEXT NOT NULL, created_at DATETIME DEFAULT CURRENT_TIMESTAMP)`);
  
  return db;
}

function saveDB() {
  if (!db) return;
  const data = db.export();
  const buffer = Buffer.from(data);
  const dir = path.join(__dirname, '../data');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'penpal.db'), buffer);
}

app.post('/api/signup', async (req, res) => {
  const { username, email, password, publicKey, encryptedPrivateKey, profileData } = req.body;
  try {
    const hashedPassword = await bcrypt.hash(password, 10);
    const pid = generatePID();
    const friendlyName = profileData?.friendlyName || username;
    const bio = profileData?.bio || '';
    
    db.run(`INSERT INTO users (username, email, password_hash, public_key, encrypted_private_key, pid, friendly_name, bio, profile_data)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [username, email, hashedPassword, publicKey || '', encryptedPrivateKey || '', pid, friendlyName, bio, JSON.stringify(profileData || {})]);
    
    const result = db.exec("SELECT last_insert_rowid() as id");
    const lastId = result[0]?.values[0]?.[0];
    const token = jwt.sign({ id: lastId, username, pid }, JWT_SECRET);
    saveDB();
    res.json({ token, user: { id: lastId, username, email, pid, friendly_name: friendlyName } });
  } catch (err) {
    console.error('Signup error:', err.message);
    res.status(400).json({ error: 'Username or email already exists' });
  }
});

app.post('/api/login', async (req, res) => {
  const { email, password } = req.body;
  try {
    const stmt = db.prepare('SELECT * FROM users WHERE email = ?');
    stmt.bind([email]);
    let user = null;
    if (stmt.step()) user = stmt.getAsObject();
    stmt.free();
    
    if (!user) return res.status(400).json({ error: 'User not found' });
    
    const validPassword = await bcrypt.compare(password, user.password_hash);
    if (!validPassword) return res.status(400).json({ error: 'Invalid password' });
    
    const token = jwt.sign({ id: user.id, username: user.username, pid: user.pid }, JWT_SECRET);
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
    console.error('Login error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/me', authenticateToken, (req, res) => {
  const stmt = db.prepare('SELECT id, username, friendly_name, email, pid, public_key, encrypted_private_key, age, birthday, favorite_food, bio, avatar_url, profile_data FROM users WHERE id = ?');
  stmt.bind([req.user.id]);
  if (stmt.step()) {
    const user = stmt.getAsObject();
    stmt.free();
    res.json(user);
  } else {
    stmt.free();
    res.status(404).json({ error: 'User not found' });
  }
});

app.put('/api/me', authenticateToken, (req, res) => {
  const { friendly_name, age, birthday, favorite_food, bio } = req.body;
  try {
    db.run(`UPDATE users SET friendly_name = COALESCE(?, friendly_name), age = COALESCE(?, age),
      birthday = COALESCE(?, birthday), favorite_food = COALESCE(?, favorite_food), bio = COALESCE(?, bio) WHERE id = ?`,
      [friendly_name, age, birthday, favorite_food, bio, req.user.id]);
    saveDB();
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Update failed' });
  }
});

app.post('/api/pairing/request', authenticateToken, (req, res) => {
  const { targetPid } = req.body;
  try {
    const stmt = db.prepare('SELECT id FROM users WHERE pid = ?');
    stmt.bind([targetPid]);
    let target = null;
    if (stmt.step()) target = stmt.getAsObject();
    stmt.free();
    
    if (!target) return res.status(404).json({ error: 'User not found' });
    
    const checkStmt = db.prepare('SELECT id FROM pairings WHERE requester_id = ? AND target_pid = ? AND status = ?');
    checkStmt.bind([req.user.id, targetPid, 'pending']);
    if (checkStmt.step()) {
      checkStmt.free();
      return res.status(400).json({ error: 'Request already sent' });
    }
    checkStmt.free();
    
    db.run('INSERT INTO pairings (requester_id, target_pid) VALUES (?, ?)', [req.user.id, targetPid]);
    db.run('INSERT INTO notifications (user_id, type, title, body) VALUES (?, ?, ?, ?)',
      [target.id, 'pairing_request', 'New Pairing Request', `${req.user.username} wants to pair with you!`]);
    saveDB();
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Could not send pairing request' });
  }
});

app.get('/api/pairing/status', authenticateToken, (req, res) => {
  let stmt = db.prepare(`SELECT p.id, u.username, u.pid FROM pairings p JOIN users u ON p.requester_id = u.id WHERE p.target_pid = ? AND p.status = 'pending'`);
  stmt.bind([req.user.pid]);
  const incoming = [];
  while (stmt.step()) incoming.push(stmt.getAsObject());
  stmt.free();

  stmt = db.prepare('SELECT id, target_pid, status FROM pairings WHERE requester_id = ?');
  stmt.bind([req.user.id]);
  const outgoing = [];
  while (stmt.step()) outgoing.push(stmt.getAsObject());
  stmt.free();

  stmt = db.prepare('SELECT * FROM pairs WHERE user1_id = ? OR user2_id = ?');
  stmt.bind([req.user.id, req.user.id]);
  let currentPair = null;
  if (stmt.step()) currentPair = stmt.getAsObject();
  stmt.free();

  let partner = null;
  if (currentPair) {
    const partnerId = currentPair.user1_id === req.user.id ? currentPair.user2_id : currentPair.user1_id;
    stmt = db.prepare('SELECT id, username, friendly_name, pid, public_key, avatar_url FROM users WHERE id = ?');
    stmt.bind([partnerId]);
    if (stmt.step()) partner = stmt.getAsObject();
    stmt.free();
  }

  res.json({ incoming, outgoing, partner });
});

app.post('/api/pairing/accept', authenticateToken, (req, res) => {
  const { requestId } = req.body;
  try {
    let stmt = db.prepare('SELECT * FROM pairings WHERE id = ?');
    stmt.bind([requestId]);
    let request = null;
    if (stmt.step()) request = stmt.getAsObject();
    stmt.free();
    
    if (!request || request.target_pid !== req.user.pid) return res.status(403).json({ error: 'Invalid request' });
    
    db.run('UPDATE pairings SET status = ? WHERE id = ?', ['accepted', requestId]);
    db.run('INSERT INTO pairs (user1_id, user2_id) VALUES (?, ?)', [request.requester_id, req.user.id]);
    db.run('INSERT INTO notifications (user_id, type, title, body) VALUES (?, ?, ?, ?)',
      [request.requester_id, 'pairing_accepted', 'Pairing Accepted', `${req.user.username} accepted your pairing request!`]);
    saveDB();
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Could not accept pairing' });
  }
});

app.post('/api/letters/send', authenticateToken, (req, res) => {
  const { recipientId, encryptedContent, encryptedMetadata, deliveredAt } = req.body;
  try {
    db.run('INSERT INTO letters (sender_id, recipient_id, encrypted_content, encrypted_metadata, delivered_at) VALUES (?, ?, ?, ?, ?)',
      [req.user.id, recipientId, encryptedContent, encryptedMetadata, deliveredAt]);
    db.run('INSERT INTO notifications (user_id, type, title, body) VALUES (?, ?, ?, ?)',
      [recipientId, 'letter_received', 'New Letter', `You received a new letter from ${req.user.username}!`]);
    saveDB();
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Could not send letter' });
  }
});

app.get('/api/letters/sync', authenticateToken, (req, res) => {
  const stmt = db.prepare('SELECT * FROM letters WHERE sender_id = ? OR recipient_id = ? ORDER BY sent_at ASC');
  stmt.bind([req.user.id, req.user.id]);
  const letters = [];
  while (stmt.step()) letters.push(stmt.getAsObject());
  stmt.free();
  res.json(letters);
});

app.post('/api/photos/upload', authenticateToken, upload.single('photo'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  try {
    db.run('INSERT INTO photos (user_id, filename, filepath) VALUES (?, ?, ?)', [req.user.id, req.file.filename, `/uploads/${req.file.filename}`]);
    const result = db.exec("SELECT last_insert_rowid() as id");
    saveDB();
    res.json({ id: result[0]?.values[0]?.[0], url: `/uploads/${req.file.filename}` });
  } catch (err) {
    res.status(500).json({ error: 'Upload failed' });
  }
});

app.get('/api/notifications', authenticateToken, (req, res) => {
  const stmt = db.prepare('SELECT * FROM notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT 50');
  stmt.bind([req.user.id]);
  const notifications = [];
  while (stmt.step()) notifications.push(stmt.getAsObject());
  stmt.free();
  res.json(notifications);
});

app.put('/api/notifications/read', authenticateToken, (req, res) => {
  db.run('UPDATE notifications SET read = 1 WHERE user_id = ?', [req.user.id]);
  saveDB();
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

async function startServer() {
  try {
    await initDB();
    console.log('Database initialized');
  } catch (e) {
    console.error('Failed to init DB:', e);
  }
  
  app.listen(PORT, () => {
    console.log(`PenPal Archive running on http://localhost:${PORT}`);
  });
}

startServer();
