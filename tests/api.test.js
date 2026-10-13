import fs from 'fs';
import os from 'os';
import path from 'path';

// Must be set before the app (and db.js) are imported, so the suite never touches
// a real ./data directory.
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-not-for-production-1234567890';
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'penpal-test-'));

const { describe, it, expect, afterAll } = await import('vitest');
const { default: request } = await import('supertest');
const { app } = (await import('../server/index.js')).default;
const { closeDB } = (await import('../server/db.js')).default;

afterAll(() => {
  closeDB();
  fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true });
});

let counter = 0;
const signup = async (over = {}) => {
  counter += 1;
  const res = await request(app).post('/api/signup').send({
    username: `user_${counter}_${Math.random().toString(36).slice(2, 8)}`,
    email: `user${counter}_${Math.random().toString(36).slice(2, 8)}@test.local`,
    password: 'password123',
    ...over,
  });
  expect(res.status).toBe(200);
  return res.body;
};

const asUser = (token) => ({ Authorization: `Bearer ${token}` });

/** Signs up two users and pairs them, returning both. */
async function pairedCouple() {
  const a = await signup();
  const b = await signup();
  const req = await request(app)
    .post('/api/pairing/request')
    .set(asUser(a.token))
    .send({ targetPid: b.user.pid });
  expect(req.status).toBe(200);

  const status = await request(app).get('/api/pairing/status').set(asUser(b.token));
  const pending = status.body.incoming.find((r) => r.username === a.user.username);
  expect(pending).toBeTruthy();

  const accepted = await request(app)
    .post('/api/pairing/accept')
    .set(asUser(b.token))
    .send({ requestId: pending.id });
  expect(accepted.status).toBe(200);

  return { a, b };
}

describe('auth', () => {
  it('signs a new user up and returns a token and a PID', async () => {
    const { token, user } = await signup();
    expect(token).toBeTruthy();
    expect(user.pid).toMatch(/^[A-Z0-9]{6}$/);
  });

  it('logs in with correct credentials', async () => {
    const email = `login_${Math.random().toString(36).slice(2, 10)}@test.local`;
    await signup({ email });
    const res = await request(app).post('/api/login').send({ email, password: 'password123' });
    expect(res.status).toBe(200);
    expect(res.body.token).toBeTruthy();
  });

  it('returns the SAME error for a wrong password and an unknown account', async () => {
    const email = `enum_${Math.random().toString(36).slice(2, 10)}@test.local`;
    await signup({ email });

    const wrongPassword = await request(app).post('/api/login').send({ email, password: 'nope' });
    const unknownUser = await request(app).post('/api/login').send({
      email: 'definitely-not-here@test.local',
      password: 'nope',
    });

    // v0.0.2 answered "User not found" vs "Invalid password", which is an account
    // enumeration oracle. Both must now be indistinguishable.
    expect(wrongPassword.status).toBe(401);
    expect(unknownUser.status).toBe(401);
    expect(wrongPassword.body.error).toBe(unknownUser.body.error);
  });

  it('rejects an unauthenticated request to a protected route', async () => {
    const res = await request(app).get('/api/me');
    expect(res.status).toBe(401);
  });
});

describe('pairing', () => {
  it('pairs two users and surfaces the partner', async () => {
    const { a, b } = await pairedCouple();
    const res = await request(app).get('/api/pairing/status').set(asUser(a.token));
    expect(res.body.partner).toBeTruthy();
    expect(res.body.partner.id).toBe(b.user.id);
  });

  it('refuses to accept a second pairing while already paired', async () => {
    const { a, b } = await pairedCouple();
    const third = await signup();

    // `b` is already paired with `a`, so `a` inviting `third` cannot be accepted.
    const req = await request(app)
      .post('/api/pairing/request')
      .set(asUser(a.token))
      .send({ targetPid: third.user.pid });
    expect(req.status).toBe(200);

    const thirdStatus = await request(app).get('/api/pairing/status').set(asUser(third.token));
    const invite = thirdStatus.body.incoming.find((r) => r.username === a.user.username);

    const res = await request(app)
      .post('/api/pairing/accept')
      .set(asUser(third.token))
      .send({ requestId: invite.id });

    expect(res.status).toBe(409);

    // And the original pairing is untouched.
    const stillPaired = await request(app).get('/api/pairing/status').set(asUser(b.token));
    expect(stillPaired.body.partner.id).toBe(a.user.id);
  });

  it('unpairing clears the partner for both sides', async () => {
    const { a, b } = await pairedCouple();
    const res = await request(app).delete('/api/pairs/unpair').set(asUser(a.token));
    expect(res.status).toBe(200);

    const aSide = await request(app).get('/api/pairing/status').set(asUser(a.token));
    const bSide = await request(app).get('/api/pairing/status').set(asUser(b.token));
    expect(aSide.body.partner).toBeNull();
    expect(bSide.body.partner).toBeNull();
  });
});

describe('letters', () => {
  it('refuses to send to someone you are not paired with', async () => {
    const a = await signup();
    const b = await signup();
    const res = await request(app)
      .post('/api/letters/send')
      .set(asUser(a.token))
      .send({ recipientId: b.user.id, encryptedContent: 'aGVsbG8=' });
    expect(res.status).toBe(403);
  });

  it('delivers a letter to a paired partner', async () => {
    const { a, b } = await pairedCouple();
    const res = await request(app)
      .post('/api/letters/send')
      .set(asUser(a.token))
      .send({ recipientId: b.user.id, encryptedContent: JSON.stringify({ v: 2, ct: 'x' }) });

    expect(res.status).toBe(200);

    const inbox = await request(app).get('/api/letters/sync').set(asUser(b.token));
    expect(inbox.body).toHaveLength(1);
  });

  it('hides a scheduled letter from the recipient until it is due', async () => {
    const { a, b } = await pairedCouple();
    const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();

    await request(app)
      .post('/api/letters/send')
      .set(asUser(a.token))
      .send({
        recipientId: b.user.id,
        encryptedContent: JSON.stringify({ v: 2, ct: 'later' }),
        deliveredAt: future,
      });

    // The sender sees it sitting in transit...
    const sent = await request(app).get('/api/letters/sync').set(asUser(a.token));
    expect(sent.body).toHaveLength(1);

    // ...the recipient sees nothing at all.
    // v0.0.2 stored delivered_at and never filtered on it, so scheduled mail
    // arrived immediately and the date picker was decorative.
    const inbox = await request(app).get('/api/letters/sync').set(asUser(b.token));
    expect(inbox.body).toHaveLength(0);
  });

  it('delivers a scheduled letter once its time has passed', async () => {
    const { a, b } = await pairedCouple();
    const past = new Date(Date.now() - 60 * 1000).toISOString();

    await request(app)
      .post('/api/letters/send')
      .set(asUser(a.token))
      .send({
        recipientId: b.user.id,
        encryptedContent: JSON.stringify({ v: 2, ct: 'arrived' }),
        deliveredAt: past,
      });

    const inbox = await request(app).get('/api/letters/sync').set(asUser(b.token));
    expect(inbox.body).toHaveLength(1);
  });

  it('never exposes another user’s letters', async () => {
    const { a } = await pairedCouple();
    const stranger = await signup();

    const res = await request(app).get('/api/letters/sync').set(asUser(stranger.token));
    expect(res.body).toHaveLength(0);
  });
});

describe('uploads', () => {
  it('rejects an SVG, which could otherwise run script on our own origin', async () => {
    const a = await signup();
    const res = await request(app)
      .post('/api/photos/upload')
      .set(asUser(a.token))
      .attach('photo', Buffer.from('<svg onload="alert(1)"></svg>'), {
        filename: 'payload.svg',
        contentType: 'image/svg+xml',
      });
    expect(res.status).toBe(400);
  });

  it('rejects a non-image', async () => {
    const a = await signup();
    const res = await request(app)
      .post('/api/photos/upload')
      .set(asUser(a.token))
      .attach('photo', Buffer.from('not an image'), {
        filename: 'evil.txt',
        contentType: 'text/plain',
      });
    expect(res.status).toBe(400);
  });

  it('accepts a PNG and does not preserve the client-supplied extension', async () => {
    const a = await signup();
    const res = await request(app)
      .post('/api/photos/upload')
      .set(asUser(a.token))
      .attach('photo', Buffer.from('89504e470d0a1a0a', 'hex'), {
        filename: 'photo.png',
        contentType: 'image/png',
      });

    expect(res.status).toBe(200);
    // The v0.0.2 bug: filename extension came from the client, so an .svg
    // became a same-origin script execution vector.
    expect(res.body.url).toMatch(/\.png$/);
  });

  it('does not serve uploads without authentication', async () => {
    const res = await request(app).get('/uploads/anything.png');
    expect([401, 403, 404]).toContain(res.status);
  });
});