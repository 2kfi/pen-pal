# Security

This document describes what PenPal actually does about security. It is written
to be true on the day you read it, including about the parts that are missing.
If a claim here cannot be demonstrated, it should not be here.

Consistent with [SELF-HOSTING.md §7](SELF-HOSTING.md#7-what-this-app-is-not):
PenPal is not anonymous, not a social network, not fully private yet, and not
audited.

---

## Reporting a vulnerability
- [What an attacker with the database CAN read](#what-an-attacker-with-the-database-can-read)
- [What an attacker with the database CANNOT read](#what-an-attacker-with-the-database-cannot-read)
- [Uploaded photos are not encrypted at rest](#uploaded-photos-are-not-encrypted-at-rest)
- [What is in place](#what-is-in-place)
- [There has been no third-party audit](#there-has-been-no-third-party-audit)
- [If you are self-hosting](#if-you-are-self-hosting)

Consistent with [SELF-HOSTING.md §7](SELF-HOSTING.md#7-what-this-app-is-not):
PenPal is not anonymous, not a social network, not fully private yet, and not
audited.

See also [MIGRATION.md](MIGRATION.md) for upgrading, backup and rollback.

---

## Reporting a vulnerability

Open a **private** security advisory on the repository:
**Security → Report a vulnerability** on the GitHub repo page. Do not open a
public issue.

Please include:

- what you did, step by step
- what you expected and what happened instead
- the version (`docker compose exec pen-pal node -e "console.log(require('/app/package.json').version)"`)
- any request id from the response or logs, which is the fastest way for us to
  find the exact request

We will acknowledge within a few days. We cannot promise a fix timeline,
because this is volunteer work.

**Encrypting a report:** if your report is sensitive enough that a public
advisory URL is a concern, say so in the advisory body and we will arrange an
encrypted channel. For anything genuinely dangerous, email is better than the
tracker — do not put an exploit in a public issue even briefly.

---

## The threat model

### Who we are defending against

PenPal is built for a specific case: **two people who want to write letters to
each other, on a server one of them runs.** That shapes everything.

The realistic adversary is a person who obtains the server's disk, or a backup
of it — a stolen laptop, a provider, a decommissioned disk, a leaked NAS, a
household member, an opportunistic thief. The second most realistic adversary
is someone with an account on the instance abusing what they can reach: their
own letters, the presence of other accounts, or an unpatched dependency.

The second most realistic is someone on the network path, if you have not put
TLS in front.

### Who we are NOT defending against

- **A global adversary with the ability to observe or modify the server while
  it runs.** We are not trying to stop a state actor with shell access.
- **Someone who has both the server and a user's password.** The private key is
  unwrapped from the password client-side, so this is a full compromise by
  construction. See below.
- **Physical attacks on a running machine** (cold boot, memory forensics).

### Assumptions we make, and you should check

| Assumption | If it is false |
|---|---|
| The server's disk and backups are not readable by anyone else | This document's encryption section does not apply |
| TLS terminates in front of the app | Browsers refuse to expose Web Crypto on plain HTTP, so the app refuses to send rather than downgrade |
| `JWT_SECRET` is long, random, and not committed | Anyone with it can mint sessions |
| The host is not running other untrusted software as the app user | Same-user processes can read `uploads/` |
| Filesystem permissions on `uploads/` and `data/` are not world-readable | The photos and the database are public |

---

## What an attacker with the database CAN read

**If someone has `data/penpal.db`, assume they can read everything below.**
Encryption does not help here, because these are not encrypted.

| Data | Readable? | Notes |
|---|---|---|
| Usernames, friendly names, email addresses | **yes** | plaintext columns |
| PIDs | **yes** | the address book of the network |
| Password hashes | **yes** | bcrypt, cost 10 — see the caveat below |
| **Uploaded photos and attachments** | **yes** | stored unencrypted. See the section below. |
| Which two users are paired | **yes** | who talks to whom, and how often |
| Number of letters, timestamps, sizes | **yes** | traffic metadata |
| Which letters are unread, in transit, or scheduled | **yes** | metadata |
| Notification titles and bodies | **yes** | plaintext |
| Profile data (age, birthday, favourite food, bio) | **yes** | plaintext |
| **Letter bodies** | **no** | see below |
| Encrypted private keys | **no, but reusable** | ciphertext wrapped with the password; see below |

Two things worth stating plainly:

**The relationship graph is exposed.** Pairings are plaintext. "Who is writing
to whom, and how often" is often the most sensitive part of a correspondence
even when the content is not.

**A bcrypt hash at cost 10 is crackable.** The implementation raises this to 12
in development tooling, but the shipped cost is 10 and passwords of poor quality
fall to offline cracking quickly. The password is also the key that unwraps the
private key, so a recovered password is worse than a recovered hash elsewhere in
a typical system.

### Encrypted private keys are reusable, not safe

`users.encrypted_private_key` is the user's private key wrapped with a key
derived from their password via PBKDF2 (600,000 iterations). It is unreadable
without the password — **but** the whole point of the password is to protect it,
and it is also the thing that makes an offline attack worth running. Protecting
it is not independent of protecting the password.

---

## What an attacker with the database CANNOT read

**Letter bodies.** Encrypted in the browser with AES-256-GCM, using a key
generated per letter and wrapped to both participants' public keys. Additional
authenticated data binds the sender, recipient and timestamp, so ciphertext
cannot be moved between letters or reordered without detection.

To read a letter body an attacker needs one of:

- the recipient's private key **and** its password, or
- the sender's private key **and** its password, or
- a weakness in AES-256-GCM or in the key derivation.

There is no server-side copy in plaintext, and no endpoint that returns one.

Two honest limits on that guarantee:

1. **Anyone who can see the recipient's screen can read the letter.** A
   compromised device, a screenshot, or shoulder-surfing is outside the model.
2. **Forwarded plaintext.** If a user copies a letter into another app, that
   copy is not protected by any of this.

---

## Uploaded photos are not encrypted at rest

**This is the largest gap in the app and it contradicts the end-to-end promise
for attachments.**

- Photo files in `uploads/` are written as ordinary files, in the clear.
- Anyone who can read the filesystem or a backup of it can open every photo.
- The server does not hold photo keys and cannot decrypt them, because there
  are none.
- **A backup that includes `uploads/` contains readable photos.** Backups of
  the database alone do not, but that is not a defence of the photos — it is
  just a smaller file to lose.

What *is* done about uploads:

- the file is served only to an authenticated request, not at a public URL
- the upload pipeline sniffs real magic bytes rather than trusting the client's
  `Content-Type`
- images are re-encoded through sharp, which strips EXIF (including GPS), ICC
  profiles, and anything appended after the image data
- the pixel count is capped, and both a full-size and a thumbnail are produced

Those controls stop a stored-XSS or decompression-bomb attack. They do nothing
for confidentiality of the bytes at rest. Closing the gap properly means
encrypting in the browser before upload and decrypting on read, which changes
the upload API, the reading path, and the threat model of the server itself.

If photos matter to you, treat `uploads/` as sensitive and encrypt the whole
backup before copying it off the machine.

---

## What is in place

Claimed only where there is a test or a mechanism to check.

**Transport and headers**

- HSTS-capable helmet defaults with an explicit CSP
- HTTPS is required in practice: Web Crypto is unavailable in a non-secure
  context, and the app refuses to send a letter rather than falling back to
  plaintext

**Authentication**

- bcrypt password hashing
- login responses are identical for "no such user" and "wrong password", and a
  dummy hash is compared on the miss path, so there is no timing or message
  oracle for account enumeration
- `JWT_SECRET` must be non-default in production
- rate limits on signup, login, and writes

**Authorisation**

- every letter, pairing, notification and upload route is authenticated, and
  scoped to the requesting user
- `/uploads` is behind auth and serves nothing but raster output

**Data handling**

- letter bodies encrypted client-side; the server stores ciphertext only
- uploads re-encoded and stripped of metadata
- no request bodies in logs; only method, path, status, duration, and id

**Operational**

- `/healthz` returns 503 when the database is unreachable or a migration is
  pending, so it is a readiness check rather than a liveness probe
- every request gets an id, echoed in `X-Request-ID`, attached to every log
  line, and included in error responses, so a report can be traced to a request
- admin ops routes require `ADMIN_TOKEN` and are **closed, not open** when it is
  unset; the token is compared in constant time and is never accepted in a query
  string
- backups use SQLite's online backup API and are verified with
  `integrity_check` plus a checksum before they are reported as good
- migrations are transactional and recorded in a ledger, so a half-applied
  migration is not a state the app can reach

**Known gaps, collected**

- uploaded photos unencrypted at rest
- no multi-factor authentication
- no audit log of administrative actions beyond ordinary request logging
- `ADMIN_TOKEN` is a shared secret with no rotation story
- the login rate limit is per-IP unless the request is authenticated, so a
  shared NAT address can lock each other out
- dependency scanning is whatever CI happens to run, not a pinned audit

---

## There has been no third-party audit

**No independent security review of this codebase has been performed.**

Everything in this document is the author's own assessment, and an assessment by
the person who wrote the code is worth less than an independent one. Treat the
threat model above as a claim, not a certification.

Before you rely on this app for anything you would mind losing:

- read `server/lib/uploads.js` and `server/routes/` yourself
- confirm your instance is on HTTPS
- make sure `JWT_SECRET` is strong and `ADMIN_TOKEN` is set
- **encrypt your backups before moving them anywhere**
- run a dependency audit (`npm audit`) and read what it says

The app is small enough to read in an afternoon. That is the most credible
security measure available here, and it is available to you.

---

## If you are self-hosting

A short list, because this is the part that actually protects anyone.

1. **HTTPS, properly.** Not self-signed-and-ignored in a way that produces
   browser warnings — a warning means the Web Crypto path is fragile.
2. **`JWT_SECRET=$(openssl rand -base64 32)`** and `ADMIN_TOKEN` set to
   something you have not written down in the repo.
3. **`chmod 700` on `data/` and `uploads/`**, and do not run the app as root.
4. **Back up on a schedule** (`./scripts/backup.sh`) and **restore one at least
   once**, to a scratch machine, to confirm it works. A backup you have never
   restored is a rumour.
5. **Encrypt backups before copying them off-site.** They contain readable
   photos and your partners' email addresses.
6. **Watch the logs.** Every line is JSON with a request id. `ADMIN_TOKEN is not
   set; refusing` and `admin auth failed` are worth investigating.
7. **Keep `uploads/` and `data/` off anything shared** — no NFS, no
   world-readable SMB, no cloud folder that syncs by URL.