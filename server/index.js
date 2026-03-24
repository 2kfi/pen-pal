require('dotenv').config();
const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('./db');
const { v4: uuidv4 } = require('uuid');

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key';

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Helper to generate a unique PID
function generatePID() {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}

// Middleware: Authenticate JWT
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

// --- AUTH ROUTES ---

app.post('/api/signup', async (req, res) => {
  const { username, email, password, publicKey, encryptedPrivateKey, profileData } = req.body;

  try {
    const hashedPassword = await bcrypt.hash(password, 10);
    const pid = generatePID();

    const stmt = db.prepare(`
      INSERT INTO users (username, email, password_hash, public_key, encrypted_private_key, pid, profile_data)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    const result = stmt.run(username, email, hashedPassword, publicKey, encryptedPrivateKey, pid, JSON.stringify(profileData || {}));
    
    const token = jwt.sign({ id: result.lastInsertRowid, username, pid }, JWT_SECRET);
    res.json({ token, user: { id: result.lastInsertRowid, username, email, pid } });
  } catch (err) {
    res.status(400).json({ error: 'Username or email already exists' });
  }
});

app.post('/api/login', async (req, res) => {
  const { email, password } = req.body;

  try {
    const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
    if (!user) return res.status(400).json({ error: 'User not found' });

    const validPassword = await bcrypt.compare(password, user.password_hash);
    if (!validPassword) return res.status(400).json({ error: 'Invalid password' });

    const token = jwt.sign({ id: user.id, username: user.username, pid: user.pid }, JWT_SECRET);
    res.json({ 
      token, 
      user: { 
        id: user.id, 
        username: user.username, 
        email: user.email, 
        pid: user.pid,
        publicKey: user.public_key,
        encryptedPrivateKey: user.encrypted_private_key
      } 
    });
  } catch (err) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/me', authenticateToken, (req, res) => {
  const user = db.prepare('SELECT id, username, email, pid, public_key, profile_data FROM users WHERE id = ?').get(req.user.id);
  res.json(user);
});

// --- PAIRING ROUTES ---

app.post('/api/pairing/request', authenticateToken, (req, res) => {
  const { targetPid } = req.body;

  try {
    const stmt = db.prepare('INSERT INTO pairings (requester_id, target_pid) VALUES (?, ?)');
    stmt.run(req.user.id, targetPid);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Could not send pairing request' });
  }
});

app.get('/api/pairing/status', authenticateToken, (req, res) => {
  const incoming = db.prepare(`
    SELECT p.id, u.username, u.pid 
    FROM pairings p
    JOIN users u ON p.requester_id = u.id
    WHERE p.target_pid = ? AND p.status = 'pending'
  `).all(req.user.pid);

  const outgoing = db.prepare(`
    SELECT id, target_pid, status 
    FROM pairings 
    WHERE requester_id = ?
  `).all(req.user.id);

  const currentPair = db.prepare(`
    SELECT * FROM pairs WHERE user1_id = ? OR user2_id = ?
  `).get(req.user.id, req.user.id);

  let partner = null;
  if (currentPair) {
    const partnerId = currentPair.user1_id === req.user.id ? currentPair.user2_id : currentPair.user1_id;
    partner = db.prepare('SELECT id, username, pid, public_key FROM users WHERE id = ?').get(partnerId);
  }

  res.json({ incoming, outgoing, partner });
});

app.post('/api/pairing/accept', authenticateToken, (req, res) => {
  const { requestId } = req.body;

  try {
    const request = db.prepare('SELECT * FROM pairings WHERE id = ?').get(requestId);
    if (!request || request.target_pid !== req.user.pid) {
      return res.status(403).json({ error: 'Invalid request' });
    }

    db.transaction(() => {
      db.prepare('UPDATE pairings SET status = "accepted" WHERE id = ?').run(requestId);
      db.prepare('INSERT INTO pairs (user1_id, user2_id) VALUES (?, ?)').run(request.requester_id, req.user.id);
    })();

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Could not accept pairing' });
  }
});

// --- LETTER ROUTES ---

app.post('/api/letters/send', authenticateToken, (req, res) => {
  const { recipientId, encryptedContent, encryptedMetadata, deliveredAt } = req.body;

  try {
    const stmt = db.prepare(`
      INSERT INTO letters (sender_id, recipient_id, encrypted_content, encrypted_metadata, delivered_at)
      VALUES (?, ?, ?, ?, ?)
    `);
    stmt.run(req.user.id, recipientId, encryptedContent, encryptedMetadata, deliveredAt);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Could not send letter' });
  }
});

app.get('/api/letters/sync', authenticateToken, (req, res) => {
  const letters = db.prepare(`
    SELECT * FROM letters 
    WHERE sender_id = ? OR recipient_id = ?
    ORDER BY sent_at ASC
  `).all(req.user.id, req.user.id);

  res.json(letters);
});

const jellyfin = require('./jellyfin');

// --- JELLYFIN ROUTES ---
app.get('/api/jellyfin/libraries', authenticateToken, async (req, res) => {
    const libraries = await jellyfin.getLibraries();
    res.json(libraries);
});

app.get('/api/jellyfin/items', authenticateToken, async (req, res) => {
    const { libraryId } = req.query;
    if (!libraryId) {
        return res.status(400).json({ error: 'libraryId is required' });
    }
    const items = await jellyfin.getItems(libraryId);
    // Attach image URLs
    const itemsWithImages = items.map(item => ({
        ...item,
        imageUrl: jellyfin.getImageUrl(item.Id),
        streamUrl: item.Type === 'Audio' ? jellyfin.getStreamUrl(item.Id) : null
    }));
    res.json(itemsWithImages);
});


app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
