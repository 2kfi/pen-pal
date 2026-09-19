import path from 'path';
import fs from 'fs';
import os from 'os';

// Isolated test env must be set before the app (and db.js) is imported.
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

const signup = (over = {}) =>
  request(app).post('/api/signup').send({
    username: `user_${Math.random().toString(36).slice(2, 8)}`,
    email: `${Math.random().toString(36).slice(2, 10)}@test.local`,
    password: 'password123',
    ...over,
  });

describe('backend smoke', () => {
  it('signup creates a user and returns a token', async () => {
    const res = await signup();
    expect(res.status).toBe(200);
    expect(res.body.token).toBeTruthy();
    expect(res.body.user.pid).toBeTruthy();
  });

  it('login works with the signed-up credentials', async () => {
    const email = `${Math.random().toString(36).slice(2, 10)}@test.local`;
    await signup({ email });
    const res = await request(app).post('/api/login').send({ email, password: 'password123' });
    expect(res.status).toBe(200);
    expect(res.body.token).toBeTruthy();
  });

  it('pairing request succeeds for a valid target PID', async () => {
    const a = (await signup()).body;
    const b = (await signup()).body;
    const res = await request(app).post('/api/pairing/request')
      .set('Authorization', `Bearer ${a.token}`)
      .send({ targetPid: b.user.pid });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  it('letter send is rejected when users are not paired', async () => {
    const a = (await signup()).body;
    const b = (await signup()).body;
    const res = await request(app).post('/api/letters/send')
      .set('Authorization', `Bearer ${a.token}`)
      .send({ recipientId: b.user.id, encryptedContent: 'aGVsbG8=' });
    expect(res.status).toBe(403);
  });

  it('photo upload rejects non-image files', async () => {
    const a = (await signup()).body;
    const res = await request(app).post('/api/photos/upload')
      .set('Authorization', `Bearer ${a.token}`)
      .attach('photo', Buffer.from('not an image'), { filename: 'evil.txt', contentType: 'text/plain' });
    expect(res.status).toBe(400);
  });
});
