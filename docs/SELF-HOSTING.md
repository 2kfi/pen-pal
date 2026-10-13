# Self-hosting PenPal

A walkthrough for running this for yourself and, more importantly, for one
specific other person. There is no account recovery and no key escrow, so read
the backup section before you start writing to each other.

---

## 1. The short version

```bash
git clone https://github.com/2kfi/pen-pal.git
cd pen-pal
cp .env.example .env
sed -i "s|^JWT_SECRET=.*|JWT_SECRET=$(openssl rand -base64 32)|" .env
docker compose up -d --build
```

That runs it on port 3000. But **do not expose it over plain HTTP** — see next.

---

## 2. HTTPS is not optional here

This is not a general security recommendation, it is a hard functional
requirement. Letter encryption uses `crypto.subtle` from the Web Crypto API,
which browsers only expose in a **secure context**. That means:

| Where you run it | Encryption works? |
|---|---|
| `https://penpal.example.com` | yes |
| `http://localhost:3000` | yes (localhost is a secure context) |
| `http://192.168.1.50:3000` | **no** |

On a bare LAN address the app will not encrypt, and — by design — it will
**refuse to send the letter** rather than quietly downgrade to plaintext. You
will see an error explaining exactly this.

So: put a TLS terminator in front.

**Caddy** (easiest — it provisions certificates itself):

```caddy
penpal.example.com {
    reverse_proxy localhost:3000
}
```

**nginx**, if you already run one:

```nginx
server {
    server_name penpal.example.com;
    ssl_certificate     /etc/letsencrypt/live/penpal.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/penpal.example.com/privkey.pem;

    # Letters and attachments are the large objects.
    client_max_body_size 12m;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Real-IP $remote_addr;
    }
}
```

If you are only running this on your own LAN and never open it to the internet,
a self-signed certificate plus a manually trusted CA is enough — but you still
need *a* certificate, because without one the browser gives you an insecure
context and encryption stays switched off.

---

## 3. Finding each other

Each account gets a six-character **PID** — your address on this network.

1. Sign up. Your keypair is generated **in your browser** at this moment. The
   private half is wrapped with your password and never sent in usable form.
2. Share your PID however you like: Signal, in person, over whatever channel
   you already trust.
3. They enter it, send an invite, you accept.

One account pairs with one person. Accepting a second invite is refused while
you are already paired — unpair first.

### There is no password reset

Your password is also the key that unwraps your private key. Lose it and the
letters addressed to you are unrecoverable — not by us, not by anyone. There is
no reset flow and no escrow, by design.

Write it down somewhere real, or better, use a password manager.

---

## 4. Backups

Two things live outside the container:

| Path | What |
|---|---|
| `./data/` | `penpal.db` — accounts, pairings, letter envelopes, notifications |
| `./uploads/` | attachment blobs |

Both are bind-mounted in `docker-compose.yml`.

```bash
# Consistent copy — safe while the server is running
docker compose exec pen-pal sh -c 'sqlite3 /app/data/penpal.db ".backup /app/data/backup.db"'
docker cp pen-pal:/app/data/backup.db ./penpal-$(date +%F).db
```

Then copy `uploads/` and the database somewhere off the machine.

**What a backup does and does not protect you from.** The database contains
ciphertext and your partner's encrypted keys, so a stolen backup is a real risk
if you have not set a strong `JWT_SECRET`. It does *not* contain readable
letter bodies. Be clear-eyed: a backup of `uploads/` **does** contain readable
photos, because attachments are not yet encrypted at rest.

---

## 5. Upgrading

```bash
git pull
docker compose up -d --build
```

Your data lives in bind-mounted volumes, so it survives rebuilds and image
upgrades. Do not run `docker compose down -v` unless you intend to delete
everything.

The database is created and migrated on first boot. There is no separate
migration step yet.

---

## 6. Troubleshooting

**"Encryption is unavailable: this page is not a secure context."**
You are on plain HTTP. See section 2.

**"JWT_SECRET must be set to a non-default value"**
`NODE_ENV=production` and no usable `JWT_SECRET` in `.env`. Generate one:
`openssl rand -base64 32`.

**Invites never arrive**
Both of you must be signed in against the *same* server. If one of you is
running a local copy, the PIDs will not match — PIDs are only meaningful
within one deployment.

**A letter is not showing up for the recipient**
Check whether you set a delivery date. A letter with a future date is withheld
from the recipient by design; you will see it sitting in transit.

**"One of you is already paired"**
One account, one partner. Unpair before inviting someone else.

---

## 7. What this app is not

- **Not anonymous.** Accounts use email and a password.
- **Not a social network.** No feed, no discovery, no more than one partner.
- **Not fully private yet.** Letter bodies are encrypted. **Uploaded photos
  are not.**
- **Not audited.** No third-party security review has been done.