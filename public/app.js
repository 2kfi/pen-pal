const API_URL = '/api';

const app = {
    state: {
        token: localStorage.getItem('auth_token') || null,
        user: null,
        privateKey: null, // Decrypted private key (JWK or CryptoKey)
        partner: null,
        pairingRequests: { incoming: [], outgoing: [] }
    },

    async init() {
        console.log('Initializing Pen Pal...');
        
        // Initialize DB
        try {
            await window.DB.init(); // Assuming DB.init() is async
            console.log('Local DB Initialized');
        } catch (e) {
            console.error('Failed to init DB:', e);
        }

        if (this.state.token) {
            // Validate token and fetch user
            try {
                const res = await fetch(`${API_URL}/me`, {
                    headers: { 'Authorization': `Bearer ${this.state.token}` }
                });
                
                if (res.ok) {
                    const user = await res.json();
                    this.state.user = user;
                    this.showApp();
                    this.loadPairingStatus();
                    // We need the private key. Since we don't store the password, 
                    // we might need to prompt the user or rely on session storage if we were caching it.
                    // For now, if we auto-login, we might be missing the private key until they re-enter password 
                    // or we store a session key. 
                    // *Self-correction*: For E2E, we can't fully auto-login without the password to decrypt the key.
                    // So we will force re-login if private key is missing, or ask for password.
                    // To keep it simple for this UI rebuild: I'll clear token if we can't decrypt, forcing login.
                    // Or improved flow: Check if we have the key. If not, show a "Unlock Key" modal?
                    // Let's just force login for now to ensure security.
                    console.log('User loaded, but need private key. Forcing re-login for security in this demo.');
                    this.logout(); 
                } else {
                    this.logout();
                }
            } catch (err) {
                console.error(err);
                this.logout();
            }
        } else {
            this.showLogin();
        }
    },

    // --- Auth ---

    showLogin() {
        document.getElementById('auth-screen').style.display = 'flex';
        document.getElementById('app-container').style.display = 'none';
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

        if (!email || !password) return alert('Please fill in all fields');

        try {
            const res = await fetch(`${API_URL}/login`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ email, password })
            });

            const data = await res.json();
            if (!res.ok) throw new Error(data.error || 'Login failed');

            this.state.token = data.token;
            this.state.user = data.user;
            localStorage.setItem('auth_token', data.token);

            // Decrypt Private Key
            if (data.user.encryptedPrivateKey) {
                try {
                    console.log('Decrypting private key...');
                    const encryptedKey = JSON.parse(data.user.encryptedPrivateKey);
                    const privateKeyJwk = await window.CryptoUtils.decryptPrivateKey(encryptedKey, password);
                    this.state.privateKey = await window.CryptoUtils.importPrivateKey(privateKeyJwk);
                    console.log('Private key decrypted successfully');
                } catch (e) {
                    console.error('Failed to decrypt private key:', e);
                    alert('Failed to unlock your security key. Check your password.');
                    return;
                }
            }

            this.showApp();
            this.loadPairingStatus();
            this.startMessagePolling();

        } catch (err) {
            alert(err.message);
        }
    },

    async signup() {
        const username = document.getElementById('signup-username').value;
        const email = document.getElementById('signup-email').value;
        const password = document.getElementById('signup-password').value;

        if (!username || !email || !password) return alert('Please fill in all fields');

        try {
            console.log('Generating keys...');
            const keyPair = await window.CryptoUtils.generateKeyPair();
            const publicKeyJwk = await window.CryptoUtils.exportKey(keyPair.publicKey);
            const privateKeyJwk = await window.CryptoUtils.exportKey(keyPair.privateKey);

            console.log('Encrypting private key...');
            const encryptedPrivateKey = await window.CryptoUtils.encryptPrivateKey(privateKeyJwk, password);

            const profileData = { bio: "New to Pen Pal" };

            const res = await fetch(`${API_URL}/signup`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    username,
                    email,
                    password, // Sent for auth hashing (server doesn't store this plaintext, uses bcrypt)
                    publicKey: JSON.stringify(publicKeyJwk),
                    encryptedPrivateKey: JSON.stringify(encryptedPrivateKey),
                    profileData
                })
            });

            const data = await res.json();
            if (!res.ok) throw new Error(data.error || 'Signup failed');

            // Auto-login logic
            this.state.token = data.token;
            this.state.user = data.user;
            this.state.privateKey = keyPair.privateKey; // We already have the raw key from generation
            localStorage.setItem('auth_token', data.token);

            this.showApp();
            this.loadPairingStatus();

        } catch (err) {
            console.error(err);
            alert(err.message);
        }
    },

    logout() {
        this.state = {
            token: null,
            user: null,
            privateKey: null,
            partner: null,
            pairingRequests: { incoming: [], outgoing: [] }
        };
        localStorage.removeItem('auth_token');
        this.showLogin();
    },

    showApp() {
        document.getElementById('auth-screen').style.display = 'none';
        document.getElementById('app-container').style.display = 'flex';
        
        // Update Sidebar
        document.getElementById('current-user-name').textContent = this.state.user.username;
        document.getElementById('current-user-pid').textContent = `PID: ${this.state.user.pid}`;
        document.getElementById('current-user-avatar').textContent = this.state.user.username.charAt(0).toUpperCase();
        
        // Default View
        this.switchView('chat');
    },

    // --- Navigation ---

    switchView(view) {
        document.querySelectorAll('.main-content').forEach(el => el.classList.add('hidden'));
        document.querySelectorAll('.nav-item').forEach(el => el.classList.remove('active'));

        if (view === 'chat') {
            document.getElementById('chat-view').classList.remove('hidden');
            // Find the chat nav item - simplistic selector
            document.querySelector('.nav-item:nth-child(1)').classList.add('active');
            this.renderMessages();
        } else if (view === 'pairing') {
            document.getElementById('pairing-view').classList.remove('hidden');
            document.querySelector('.nav-item:nth-child(2)').classList.add('active');
            this.loadPairingStatus();
        }
    },

    // --- Pairing ---

    async loadPairingStatus() {
        try {
            const res = await fetch(`${API_URL}/pairing/status`, {
                headers: { 'Authorization': `Bearer ${this.state.token}` }
            });
            const data = await res.json();
            
            this.state.partner = data.partner;
            this.state.pairingRequests = {
                incoming: data.incoming || [],
                outgoing: data.outgoing || []
            };

            this.renderPairingUI();
            this.updateChatHeader();
            
        } catch (err) {
            console.error('Failed to load pairing status', err);
        }
    },

    renderPairingUI() {
        const incomingContainer = document.getElementById('incoming-requests');
        incomingContainer.innerHTML = '';

        if (this.state.pairingRequests.incoming.length === 0) {
            incomingContainer.innerHTML = '<p style="color: var(--text-muted);">No pending requests.</p>';
            return;
        }

        this.state.pairingRequests.incoming.forEach(req => {
            const div = document.createElement('div');
            div.className = 'request-item';
            div.style.background = 'var(--input-bg)';
            div.style.padding = '12px';
            div.style.marginBottom = '10px';
            div.style.borderRadius = '8px';
            div.style.display = 'flex';
            div.style.justifyContent = 'space-between';
            div.style.alignItems = 'center';

            div.innerHTML = `
                <span><strong>${req.username}</strong> (${req.pid})</span>
                <button class="btn" style="width: auto; padding: 6px 12px; font-size: 0.8rem;" onclick="app.acceptPairing(${req.id})">Accept</button>
            `;
            incomingContainer.appendChild(div);
        });
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
                alert('Failed to send request');
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
            } else {
                alert('Failed to accept');
            }
        } catch (err) {
            console.error(err);
        }
    },

    updateChatHeader() {
        const headerName = document.getElementById('chat-partner-name');
        const status = document.getElementById('connection-status');
        
        if (this.state.partner) {
            headerName.textContent = this.state.partner.username;
            status.textContent = 'Connected';
            status.style.color = 'var(--success-color)';
        } else {
            headerName.textContent = 'No Partner';
            status.textContent = 'Disconnected';
            status.style.color = 'var(--error-color)';
        }
    },

    // --- Messaging ---

    async startMessagePolling() {
        this.fetchMessages();
        setInterval(() => this.fetchMessages(), 5000); // Poll every 5s
    },

    async fetchMessages() {
        if (!this.state.partner || !this.state.privateKey) return;

        try {
            const res = await fetch(`${API_URL}/letters/sync`, {
                headers: { 'Authorization': `Bearer ${this.state.token}` }
            });
            const letters = await res.json();

            const decryptedMessages = [];
            for (const letter of letters) {
                try {
                    // Check if we already have it in local DB to avoid re-decrypting?
                    // For simplicity, decrypting on fly. Optimize later.
                    
                    // Determine if I am sender or recipient
                    const isSender = letter.sender_id === this.state.user.id;
                    
                    const encryptedContent = JSON.parse(letter.encrypted_content);
                    
                    // To decrypt, we need to know WHICH key to use from the envelope.
                    // encryptLetter returns { recipientKey, senderKey, ... }
                    // decryptLetter handles the selection if we pass the right flag.

                    const content = await window.CryptoUtils.decryptLetter(
                        encryptedContent, 
                        this.state.privateKey, 
                        isSender
                    );

                    decryptedMessages.push({
                        id: letter.id,
                        content,
                        senderId: letter.sender_id,
                        timestamp: letter.delivered_at || letter.sent_at
                    });
                } catch (e) {
                    console.error('Failed to decrypt message', letter.id, e);
                    decryptedMessages.push({
                        id: letter.id,
                        content: '⚠️ Decryption Error',
                        senderId: letter.sender_id,
                        timestamp: letter.sent_at,
                        error: true
                    });
                }
            }
            
            this.state.messages = decryptedMessages;
            this.renderMessages();

        } catch (err) {
            console.error('Fetch messages error:', err);
        }
    },

    renderMessages() {
        const container = document.getElementById('messages-container');
        if (!this.state.messages || this.state.messages.length === 0) {
            container.innerHTML = '<div style="text-align: center; color: var(--text-muted); margin-top: 50px;">No messages yet. Start talking!</div>';
            return;
        }

        container.innerHTML = '';
        this.state.messages.forEach(msg => {
            const isMe = msg.senderId === this.state.user.id;
            const div = document.createElement('div');
            div.className = `message ${isMe ? 'sent' : 'received'}`;
            div.textContent = msg.content;
            
            if (msg.error) div.style.color = 'var(--error-color)';

            const meta = document.createElement('div');
            meta.className = 'message-meta';
            const date = new Date(msg.timestamp);
            meta.textContent = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
            
            div.appendChild(meta);
            container.appendChild(div);
        });

        // Scroll to bottom
        container.scrollTop = container.scrollHeight;
    },

    async sendMessage() {
        const input = document.getElementById('message-input');
        const content = input.value.trim();
        if (!content) return;
        
        if (!this.state.partner) return alert('No partner connected!');

        try {
            // Get partner's public key
            const partnerPublicKey = JSON.parse(this.state.partner.public_key);
            
            // Get my public key (from user object or export from private key? User object has it as string)
            // Wait, we need it as JWK. The user object in DB has it stored as JSON string of JWK.
            // Let's verify `server/index.js`... yes, it stores `publicKey` as passed from signup.
            
            // Wait, `this.state.user.publicKey` might be snake_case `public_key` depending on how `api/me` returns it.
            // `api/me` selects `public_key`.
            const myPublicKey = JSON.parse(this.state.user.public_key);

            const encryptedData = await window.CryptoUtils.encryptLetter(
                content,
                partnerPublicKey, // Recipient
                myPublicKey      // Sender (so I can read it later)
            );

            const res = await fetch(`${API_URL}/letters/send`, {
                method: 'POST',
                headers: { 
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${this.state.token}` 
                },
                body: JSON.stringify({
                    recipientId: this.state.partner.id, // We need ID, pairing endpoint returns partner with ID?
                    // api/pairing/status -> partner object has `id`. Yes.
                    encryptedContent: JSON.stringify(encryptedData),
                    encryptedMetadata: "{}", // placeholder
                    deliveredAt: new Date().toISOString()
                })
            });

            if (res.ok) {
                input.value = '';
                this.fetchMessages(); // Refresh immediately
            } else {
                alert('Failed to send');
            }

        } catch (err) {
            console.error('Send error:', err);
            alert('Encryption or Network failed');
        }
    }
};

// Start
window.addEventListener('DOMContentLoaded', () => {
    app.init();
    window.app = app; // Expose for HTML onclick handlers
});
