const API_URL = '/api';

const app = {
  state: {
    token: localStorage.getItem('auth_token') || null,
    user: null,
    privateKey: null,
    partner: null,
    pairingRequests: { incoming: [], outgoing: [] },
    letters: [],
    notifications: [],
    currentView: 'letters',
    currentTheme: localStorage.getItem('theme') || 'white-light',
    isDarkMode: false,
    uploadedPhotos: []
  },

  async init() {
    console.log('Initializing PenPal Archive...');
    
    // Check system preference
    const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    this.state.isDarkMode = prefersDark;
    
    // If no saved theme, default to white
    if (!localStorage.getItem('theme')) {
      this.state.currentTheme = 'white-light';
    }
    
    this.applyTheme(this.state.currentTheme);
    
    try {
      await window.DB.init();
      console.log('Local DB ready');
    } catch (e) {
      console.error('DB init failed:', e);
    }

    if (this.state.token) {
      try {
        const res = await fetch(`${API_URL}/me`, {
          headers: { 'Authorization': `Bearer ${this.state.token}` }
        });
        if (res.ok) {
          const user = await res.json();
          this.state.user = user;
          this.showApp();
          this.loadPairingStatus();
          this.loadNotifications();
          return;
        }
      } catch (e) {
        console.error('Token validation failed');
      }
      this.logout();
    } else {
      this.showLogin();
    }
  },

  applyTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    document.querySelectorAll('.theme-swatch').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.theme === theme);
    });
  },

  // --- Auth ---
  showLogin() {
    document.getElementById('auth-screen').classList.add('active');
    document.getElementById('app-container').classList.remove('active');
    document.getElementById('login-form').classList.remove('hidden');
    document.getElementById('signup-form').classList.add('hidden');
  },

  showSignup() {
    document.getElementById('login-form').classList.add('hidden');
    document.getElementById('signup-form').classList.remove('hidden');
  },

  async login() {
    const email = document.getElementById('login-email').value;
    const password = document.getElementById('login-password').value;
    if (!email || !password) return alert('Please fill all fields');

    try {
      const res = await fetch(`${API_URL}/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);

      this.state.token = data.token;
      this.state.user = data.user;
      localStorage.setItem('auth_token', data.token);

      if (data.user.encryptedPrivateKey) {
        const encryptedKey = JSON.parse(data.user.encryptedPrivateKey);
        const privateKeyJwk = await window.CryptoUtils.decryptPrivateKey(encryptedKey, password);
        this.state.privateKey = await window.CryptoUtils.importPrivateKey(privateKeyJwk);
      }

      this.showApp();
      this.loadPairingStatus();
      this.loadNotifications();

    } catch (err) {
      alert(err.message);
    }
  },

  async signup() {
    const username = document.getElementById('signup-username').value;
    const email = document.getElementById('signup-email').value;
    const password = document.getElementById('signup-password').value;
    if (!username || !email || !password) return alert('Please fill all fields');

    try {
      const keyPair = await window.CryptoUtils.generateKeyPair();
      const publicKeyJwk = await window.CryptoUtils.exportKey(keyPair.publicKey);
      const privateKeyJwk = await window.CryptoUtils.exportKey(keyPair.privateKey);
      const encryptedPrivateKey = await window.CryptoUtils.encryptPrivateKey(privateKeyJwk, password);

      const res = await fetch(`${API_URL}/signup`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username, email, password,
          publicKey: JSON.stringify(publicKeyJwk),
          encryptedPrivateKey: JSON.stringify(encryptedPrivateKey),
          profileData: { friendlyName: username, bio: '' }
        })
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.error);

      this.state.token = data.token;
      this.state.user = data.user;
      this.state.privateKey = keyPair.privateKey;
      localStorage.setItem('auth_token', data.token);

      this.showApp();
      this.loadPairingStatus();

    } catch (err) {
      alert(err.message);
    }
  },

  logout() {
    this.state = {
      token: null, user: null, privateKey: null, partner: null,
      pairingRequests: { incoming: [], outgoing: [] },
      letters: [], notifications: [], currentView: 'letters',
      currentTheme: this.state.currentTheme, uploadedPhotos: []
    };
    localStorage.removeItem('auth_token');
    this.showLogin();
  },

  showApp() {
    document.getElementById('auth-screen').classList.remove('active');
    document.getElementById('app-container').classList.add('active');
    
    const user = this.state.user;
    document.getElementById('sidebar-name').textContent = user.friendly_name || user.username;
    document.getElementById('sidebar-pid').textContent = `PID: ${user.pid}`;
    document.getElementById('sidebar-avatar').textContent = (user.friendly_name || user.username).charAt(0).toUpperCase();
    document.getElementById('my-pid').textContent = user.pid;

    // Load profile into settings
    document.getElementById('settings-friendly-name').value = user.friendly_name || '';
    document.getElementById('settings-bio').value = user.bio || '';
    document.getElementById('settings-age').value = user.age || '';
    document.getElementById('settings-birthday').value = user.birthday || '';
    document.getElementById('settings-food').value = user.favorite_food || '';

    this.switchView('letters');
  },

  // --- Navigation ---
  switchView(view) {
    this.state.currentView = view;
    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
    document.getElementById(`view-${view}`).classList.add('active');
    
    document.querySelectorAll('.nav-btn[data-view]').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.view === view);
    });

    if (view === 'letters') this.renderLetterPath();
    if (view === 'media') this.loadMediaLibraries();
    if (view === 'games') this.initGamesView();
  },

  // --- Pairing ---
  async loadPairingStatus() {
    try {
      const res = await fetch(`${API_URL}/pairing/status`, {
        headers: { 'Authorization': `Bearer ${this.state.token}` }
      });
      const data = await res.json();
      
      this.state.partner = data.partner;
      this.state.pairingRequests = { incoming: data.incoming || [], outgoing: data.outgoing || [] };
      
      this.renderPairingUI();
      this.updatePartnerStatus();
      
    } catch (err) {
      console.error('Failed to load pairing status', err);
    }
  },

  renderPairingUI() {
    const incomingContainer = document.getElementById('incoming-requests');
    const partnerContainer = document.getElementById('current-partner');

    if (this.state.pairingRequests.incoming.length === 0) {
      incomingContainer.innerHTML = '<p class="empty-text">No pending requests.</p>';
    } else {
      incomingContainer.innerHTML = this.state.pairingRequests.incoming.map(req => `
        <div class="request-item">
          <span><strong>${req.username}</strong> (${req.pid})</span>
          <button class="btn btn-sm btn-primary" onclick="app.acceptPairing(${req.id})">Accept</button>
        </div>
      `).join('');
    }

    if (this.state.partner) {
      partnerContainer.innerHTML = `
        <div class="request-item">
          <div class="avatar">${this.state.partner.username.charAt(0).toUpperCase()}</div>
          <span><strong>${this.state.partner.friendly_name || this.state.partner.username}</strong></span>
        </div>
      `;
    } else {
      partnerContainer.innerHTML = '<p class="empty-text">Not paired yet.</p>';
    }
  },

  updatePartnerStatus() {
    const statusBadge = document.getElementById('letters-partner-status');
    const newLetterBtn = document.getElementById('btn-new-letter');
    
    if (this.state.partner) {
      statusBadge.textContent = this.state.partner.username;
      statusBadge.classList.add('connected');
      newLetterBtn.disabled = false;
    } else {
      statusBadge.textContent = 'No partner';
      statusBadge.classList.remove('connected');
      newLetterBtn.disabled = true;
    }
  },

  async sendPairingRequest() {
    const targetPid = document.getElementById('target-pid').value.trim().toUpperCase();
    if (!targetPid) return alert('Enter a PID');

    try {
      const res = await fetch(`${API_URL}/pairing/request`, {
        method: 'POST',
        headers: { 
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.state.token}` 
        },
        body: JSON.stringify({ targetPid })
      });

      if (res.ok) {
        alert('Request sent!');
        this.loadPairingStatus();
      } else {
        const data = await res.json();
        alert(data.error || 'Failed');
      }
    } catch (err) {
      console.error(err);
    }
  },

  async acceptPairing(requestId) {
    try {
      const res = await fetch(`${API_URL}/pairing/accept`, {
        method: 'POST',
        headers: { 
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.state.token}` 
        },
        body: JSON.stringify({ requestId })
      });

      if (res.ok) {
        alert('Connected!');
        this.loadPairingStatus();
      }
    } catch (err) {
      console.error(err);
    }
  },

  // --- Letters ---
  async loadLetters() {
    if (!this.state.partner) return;
    
    try {
      const res = await fetch(`${API_URL}/letters/sync`, {
        headers: { 'Authorization': `Bearer ${this.state.token}` }
      });
      this.state.letters = await res.json();
      this.renderLetterPath();
    } catch (err) {
      console.error('Failed to load letters', err);
    }
  },

  renderLetterPath() {
    const container = document.getElementById('letter-nodes-container');
    const empty = document.getElementById('letter-path-empty');
    const svg = document.getElementById('letter-path-svg');
    
    if (!this.state.partner || this.state.letters.length === 0) {
      container.innerHTML = '';
      empty.classList.remove('hidden');
      svg.classList.add('hidden');
      return;
    }

    empty.classList.add('hidden');
    svg.classList.remove('hidden');

    const nodeCount = this.state.letters.length;
    const pathHeight = Math.max(400, nodeCount * 120);
    const centerX = 50;
    
    // Create curved path
    let pathD = `M ${centerX} 60`;
    for (let i = 1; i <= nodeCount; i++) {
      const y = 60 + i * 100;
      const wave = Math.sin(i * 0.5) * 30;
      pathD += ` Q ${centerX + wave} ${y - 50}, ${centerX + wave} ${y}`;
    }
    document.getElementById('letter-path-line').setAttribute('d', pathD);
    svg.setAttribute('viewBox', `0 0 100 ${pathHeight}`);

    // Create nodes
    container.innerHTML = '';
    this.state.letters.forEach((letter, index) => {
      const y = 60 + index * 100;
      const x = 50 + Math.sin(index * 0.5) * 30;
      const isUnread = letter.recipient_id === this.state.user.id;
      
      const node = document.createElement('div');
      node.className = `letter-node ${isUnread ? 'unread' : 'read'}`;
      node.style.left = `calc(${x}% - 35px)`;
      node.style.top = `${y - 35}px`;
      node.innerHTML = '&#9993;';
      node.title = new Date(letter.delivered_at || letter.sent_at).toLocaleDateString();
      node.onclick = () => this.openLetter(letter);
      container.appendChild(node);
    });
  },

  async openLetter(letter) {
    if (!this.state.privateKey) return;
    
    try {
      const encryptedContent = JSON.parse(letter.encrypted_content);
      const isSender = letter.sender_id === this.state.user.id;
      const content = await window.CryptoUtils.decryptLetter(encryptedContent, this.state.privateKey, isSender);
      
      document.getElementById('read-letter-title').textContent = 'Letter';
      document.getElementById('read-letter-meta').textContent = 
        `${isSender ? 'You sent' : 'From your pen pal'} • ${new Date(letter.delivered_at || letter.sent_at).toLocaleString()}`;
      document.getElementById('read-letter-body').textContent = content;
      document.getElementById('read-letter-photos').innerHTML = '';
      
      document.getElementById('letter-read-modal').classList.remove('hidden');
    } catch (e) {
      console.error('Decryption failed', e);
      alert('Could not decrypt this letter.');
    }
  },

  // --- Letter Compose ---
  openComposeModal() {
    this.state.uploadedPhotos = [];
    document.getElementById('letter-content').value = '';
    document.getElementById('letter-photo-preview').innerHTML = '';
    document.getElementById('letter-delivery-date').value = '';
    document.getElementById('letter-compose-modal').classList.remove('hidden');
  },

  closeComposeModal() {
    document.getElementById('letter-compose-modal').classList.add('hidden');
  },

  async handlePhotoUpload(e) {
    const file = e.target.files[0];
    if (!file) return;

    const formData = new FormData();
    formData.append('photo', file);

    try {
      const res = await fetch(`${API_URL}/photos/upload`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${this.state.token}` },
        body: formData
      });
      const data = await res.json();
      this.state.uploadedPhotos.push(data.url);
      
      const preview = document.getElementById('letter-photo-preview');
      const img = document.createElement('img');
      img.src = data.url;
      preview.appendChild(img);
    } catch (err) {
      console.error('Upload failed', err);
    }
  },

  async sendLetter() {
    if (!this.state.partner) return alert('No partner connected!');
    
    const content = document.getElementById('letter-content').value.trim();
    if (!content) return alert('Write something!');

    try {
      const partnerPublicKey = JSON.parse(this.state.partner.public_key);
      const myPublicKey = JSON.parse(this.state.user.public_key);

      const encryptedData = await window.CryptoUtils.encryptLetter(
        content,
        partnerPublicKey,
        myPublicKey
      );

      const deliveredAt = document.getElementById('letter-delivery-date').value || new Date().toISOString();

      await fetch(`${API_URL}/letters/send`, {
        method: 'POST',
        headers: { 
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.state.token}` 
        },
        body: JSON.stringify({
          recipientId: this.state.partner.id,
          encryptedContent: JSON.stringify(encryptedData),
          encryptedMetadata: JSON.stringify({ photos: this.state.uploadedPhotos }),
          deliveredAt
        })
      });

      this.closeComposeModal();
      this.loadLetters();
    } catch (err) {
      console.error('Send failed', err);
      alert('Failed to send letter');
    }
  },

  // --- Media ---
  async loadMediaLibraries() {
    const notConfigured = document.getElementById('media-not-configured');
    const content = document.getElementById('media-content');

    try {
      const res = await fetch(`${API_URL}/jellyfin/status`, {
        headers: { 'Authorization': `Bearer ${this.state.token}` }
      });
      const status = await res.json();

      if (!status.configured) {
        notConfigured.classList.remove('hidden');
        content.classList.add('hidden');
        return;
      }

      notConfigured.classList.add('hidden');
      content.classList.remove('hidden');

      const libRes = await fetch(`${API_URL}/jellyfin/libraries`, {
        headers: { 'Authorization': `Bearer ${this.state.token}` }
      });
      const libraries = await libRes.json();

      const container = document.getElementById('media-libraries');
      container.innerHTML = libraries.map(lib => `
        <div class="library-card" onclick="app.loadMediaItems('${lib.Id}')">
          <div class="library-icon">${this.getLibraryIcon(lib.CollectionType)}</div>
          <div class="media-item-title">${lib.Name}</div>
        </div>
      `).join('');
    } catch (err) {
      console.error('Media load failed', err);
    }
  },

  getLibraryIcon(type) {
    const icons = { movies: '&#127916;', music: '&#127925;', tvshows: '&#128250;', books: '&#128218;' };
    return icons[type] || '&#128194;';
  },

  async loadMediaItems(libraryId) {
    const container = document.getElementById('media-items');
    container.classList.remove('hidden');
    container.innerHTML = '<p style="color:var(--text-muted)">Loading...</p>';

    try {
      const res = await fetch(`${API_URL}/jellyfin/items?libraryId=${libraryId}`, {
        headers: { 'Authorization': `Bearer ${this.state.token}` }
      });
      const items = await res.json();

      container.innerHTML = items.map(item => `
        <div class="media-item" onclick="app.playMedia('${item.Id}', '${item.Type}', '${item.Name}')">
          <div class="media-item-poster">
            <img src="${item.imageUrl}" alt="${item.Name}" onerror="this.style.display='none'">
          </div>
          <div class="media-item-info">
            <div class="media-item-title">${item.Name}</div>
          </div>
        </div>
      `).join('');
    } catch (err) {
      container.innerHTML = '<p style="color:var(--error)">Failed to load items</p>';
    }
  },

  playMedia(itemId, type, title) {
    if (type !== 'Audio') return;
    
    const streamUrl = `${API_URL}/jellyfin/items?libraryId=${itemId}&stream=1`;
    const player = document.getElementById('mini-player');
    const audio = document.getElementById('mini-audio');
    
    document.getElementById('mini-player-title').textContent = title;
    document.getElementById('mini-player-artist').textContent = 'Jellyfin';
    audio.src = streamUrl;
    player.classList.remove('hidden');
    audio.play();
  },

  // --- Games ---
  initGamesView() {
    // Placeholder - chess modal logic in chess.js
  },

  // --- Settings ---
  async saveProfile() {
    const data = {
      friendly_name: document.getElementById('settings-friendly-name').value,
      bio: document.getElementById('settings-bio').value,
      age: document.getElementById('settings-age').value,
      birthday: document.getElementById('settings-birthday').value,
      favorite_food: document.getElementById('settings-food').value
    };

    try {
      await fetch(`${API_URL}/me`, {
        method: 'PUT',
        headers: { 
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.state.token}` 
        },
        body: JSON.stringify(data)
      });
      alert('Profile saved!');
    } catch (err) {
      alert('Failed to save');
    }
  },

  setTheme(theme) {
    this.state.currentTheme = theme;
    localStorage.setItem('theme', theme);
    this.applyTheme(theme);
  },

  toggleThemeMode(isDark) {
    this.state.isDarkMode = isDark;
    const baseTheme = this.state.currentTheme.replace('-light', '').replace('-dark', '');
    const newTheme = isDark ? `${baseTheme}-dark` : `${baseTheme}-light`;
    this.state.currentTheme = newTheme;
    localStorage.setItem('theme', newTheme);
    this.applyTheme(newTheme);
    
    // Update toggle buttons
    document.getElementById('theme-light').classList.toggle('active', !isDark);
    document.getElementById('theme-dark').classList.toggle('active', isDark);
  },

  // --- Notifications ---
  async loadNotifications() {
    try {
      const res = await fetch(`${API_URL}/notifications`, {
        headers: { 'Authorization': `Bearer ${this.state.token}` }
      });
      this.state.notifications = await res.json();
      this.renderNotifications();
    } catch (err) {
      console.error('Failed to load notifications', err);
    }
  },

  renderNotifications() {
    const container = document.getElementById('notif-list');
    const badge = document.getElementById('notif-count');
    
    const unread = this.state.notifications.filter(n => !n.read).length;
    badge.textContent = unread;
    badge.classList.toggle('hidden', unread === 0);

    if (this.state.notifications.length === 0) {
      container.innerHTML = '<p class="empty-text">No notifications.</p>';
      return;
    }

    container.innerHTML = this.state.notifications.map(n => `
      <div class="notif-item ${n.read ? '' : 'unread'}">
        <div class="notif-title">${n.title}</div>
        <div class="notif-body">${n.body || ''}</div>
        <div class="notif-time">${new Date(n.created_at).toLocaleString()}</div>
      </div>
    `).join('');
  },

  toggleNotifPanel() {
    const panel = document.getElementById('notif-panel');
    panel.classList.toggle('hidden');
    if (!panel.classList.contains('hidden')) {
      fetch(`${API_URL}/notifications/read`, {
        method: 'PUT',
        headers: { 'Authorization': `Bearer ${this.state.token}` }
      });
    }
  }
};

// Mini player controls
document.getElementById('mini-close').onclick = () => {
  document.getElementById('mini-player').classList.add('hidden');
  document.getElementById('mini-audio').pause();
};

document.getElementById('mini-play-pause').onclick = () => {
  const audio = document.getElementById('mini-audio');
  const playIcon = document.getElementById('icon-play');
  const pauseIcon = document.getElementById('icon-pause');
  
  if (audio.paused) {
    audio.play();
    playIcon.classList.add('hidden');
    pauseIcon.classList.remove('hidden');
  } else {
    audio.pause();
    playIcon.classList.remove('hidden');
    pauseIcon.classList.add('hidden');
  }
};

// Event listeners
document.getElementById('btn-login').onclick = () => app.login();
document.getElementById('btn-signup').onclick = () => app.signup();
document.getElementById('show-signup').onclick = (e) => { e.preventDefault(); app.showSignup(); };
document.getElementById('show-login').onclick = (e) => { e.preventDefault(); app.showLogin(); };
document.getElementById('btn-logout').onclick = () => app.logout();

document.querySelectorAll('.nav-btn[data-view]').forEach(btn => {
  btn.onclick = () => app.switchView(btn.dataset.view);
});

document.getElementById('btn-new-letter').onclick = () => app.openComposeModal();
document.getElementById('close-compose').onclick = () => app.closeComposeModal();
document.getElementById('cancel-compose').onclick = () => app.closeComposeModal();
document.getElementById('send-letter').onclick = () => app.sendLetter();
document.getElementById('letter-photo-input').onchange = (e) => app.handlePhotoUpload(e);
document.getElementById('close-read').onclick = () => document.getElementById('letter-read-modal').classList.add('hidden');

document.getElementById('btn-send-pair').onclick = () => app.sendPairingRequest();

document.getElementById('btn-save-profile').onclick = () => app.saveProfile();

document.querySelectorAll('.theme-swatch').forEach(btn => {
  btn.onclick = () => app.setTheme(btn.dataset.theme);
});

document.getElementById('theme-light').onclick = () => app.toggleThemeMode(false);
document.getElementById('theme-dark').onclick = () => app.toggleThemeMode(true);

document.getElementById('mobile-menu-btn').onclick = () => {
  document.getElementById('sidebar').classList.toggle('open');
};

document.getElementById('mobile-notif-btn').onclick = () => app.toggleNotifPanel();
document.getElementById('btn-clear-notifs').onclick = () => app.loadNotifications();

// Chess
document.getElementById('btn-play-chess').onclick = () => {
  document.getElementById('chess-modal').classList.remove('hidden');
  window.Chess.init();
};
document.getElementById('close-chess').onclick = () => {
  document.getElementById('chess-modal').classList.add('hidden');
};
document.getElementById('chess-new-game').onclick = () => window.Chess.init();

// Close modals on overlay click
document.querySelectorAll('.modal-overlay').forEach(overlay => {
  overlay.onclick = (e) => {
    if (e.target === overlay) overlay.classList.add('hidden');
  };
});

// Start
window.addEventListener('DOMContentLoaded', () => {
  app.init();
  window.app = app;
});
