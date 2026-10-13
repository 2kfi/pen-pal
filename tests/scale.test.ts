import { describe, it, expect, beforeAll, afterAll } from 'vitest';

/**
 * "What if I want 20 pairs?"
 *
 * The single-partner rule is per-account, not global: `pairs.user_id` is the
 * PRIMARY KEY, so one user maps to exactly one partner. Twenty pairs is simply
 * forty accounts, and nothing in the schema cares how many there are.
 *
 * This exists because "it should scale to N" is a claim, and claims about a
 * constraint this load-bearing deserve evidence rather than reassurance. It also
 * guards the isolation property, which is the thing that actually breaks when
 * people start sharing a server.
 */

const PAIRS = 20;
const PER_PAIR = 2;

async function main() {
  const fs = await import('fs');
  const os = await import('os');
  const path = await import('path');
  process.env.NODE_ENV = 'test';
  process.env.JWT_SECRET = 'scale-test-secret-not-for-production-123456';
  process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'penpal-scale-'));

  const request = (await import('supertest')).default;
  const { app } = (await import('../server/index.js')).default;
  const { closeDB } = (await import('../server/db.js')).default;

  return { request, app, closeDB, cleanup: process.env.DATA_DIR };
}

describe('many pairs on one server', () => {
  let ctx: Awaited<ReturnType<typeof main>> | null = null;

  beforeAll(async () => {
    ctx = await main();
  });

  afterAll(() => {
    if (!ctx) return;
    ctx.closeDB();
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const fs = require('fs') as typeof import('fs');
    fs.rmSync(ctx.cleanup, { recursive: true, force: true });
  });

  // 40 signups at 10 bcrypt rounds each is genuinely slow; the default 5s
  // vitest timeout is not a realistic budget for this.
  it(`supports ${PAIRS} independent pairs without cross-talk`, { timeout: 120_000 }, async () => {
    const { request, app } = ctx!;
    let n = 0;
    const accounts: Array<{ token: string; id: number; pid: string }> = [];

    for (let i = 0; i < PAIRS * PER_PAIR; i++) {
      n += 1;
      const res = await request(app).post('/api/signup').send({
        username: `scale_${n}_${Math.random().toString(36).slice(2, 8)}`,
        email: `scale${n}_${Math.random().toString(36).slice(2, 8)}@test.local`,
        password: 'password123',
      });
      expect(res.status).toBe(200);
      accounts.push({ token: res.body.token, id: res.body.user.id, pid: res.body.user.pid });
    }

    expect(accounts).toHaveLength(PAIRS * PER_PAIR);

    // Pair them up: (0,1), (2,3), ...
    for (let p = 0; p < PAIRS; p++) {
      const a = accounts[p * 2];
      const b = accounts[p * 2 + 1];

      const req = await request(app)
        .post('/api/pairing/request')
        .set('Authorization', `Bearer ${a.token}`)
        .send({ targetPid: b.pid });
      expect(req.status).toBe(200);

      const status = await request(app)
        .get('/api/pairing/status')
        .set('Authorization', `Bearer ${b.token}`);
      const invite = status.body.incoming.find((r: { pid: string }) => r.pid === a.pid);
      expect(invite).toBeTruthy();

      const accepted = await request(app)
        .post('/api/pairing/accept')
        .set('Authorization', `Bearer ${b.token}`)
        .send({ requestId: invite.id });
      expect(accepted.status).toBe(200);
    }

    // Every account should see exactly one partner — its own.
    for (let p = 0; p < PAIRS; p++) {
      const a = accounts[p * 2];
      const b = accounts[p * 2 + 1];
      const sa = await request(app).get('/api/pairing/status').set('Authorization', `Bearer ${a.token}`);
      const sb = await request(app).get('/api/pairing/status').set('Authorization', `Bearer ${b.token}`);
      expect(sa.body.partner.id).toBe(b.id);
      expect(sb.body.partner.id).toBe(a.id);
    }

    // Isolation: a letter from pair 0 must never appear in pair 19's archive.
    const sender = accounts[0];
    const recipient = accounts[1];
    await request(app)
      .post('/api/letters/send')
      .set('Authorization', `Bearer ${sender.token}`)
      .send({ recipientId: recipient.id, encryptedContent: JSON.stringify({ v: 2, ct: 'pair-0-secret' }) });

    const insidePair = await request(app)
      .get('/api/letters/sync')
      .set('Authorization', `Bearer ${recipient.token}`);
    expect(insidePair.body).toHaveLength(1);
    expect(insidePair.body[0].encrypted_content).toContain('pair-0-secret');

    const outsidePair = await request(app)
      .get('/api/letters/sync')
      .set('Authorization', `Bearer ${accounts[19 * 2].token}`);
    expect(outsidePair.body).toHaveLength(0);

    // A paired user still cannot write to someone outside their pairing.
    const outsider = accounts[38];
    const rejected = await request(app)
      .post('/api/letters/send')
      .set('Authorization', `Bearer ${sender.token}`)
      .send({ recipientId: outsider.id, encryptedContent: 'nope' });
    expect(rejected.status).toBe(403);
  });
});