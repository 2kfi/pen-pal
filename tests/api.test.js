import fs from 'fs';
import os from 'os';
import path from 'path';
import sharp from 'sharp';

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
  // A genuinely valid 1x1 PNG. The old implementation only looked at the magic
  // bytes, so a truncated 8-byte "89504e470d0a1a0a" was accepted; the pipeline
  // now re-encodes, so the fixtures have to be real images.
  const PNG_1x1 = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64',
  );

  const uploadDir = path.join(process.cwd(), 'uploads');
  const storedPath = (url) => path.join(process.cwd(), url.replace(/^\//, ''));

  // One shared account for the whole block. Signup is rate limited to 30 per
  // window, so a per-test signup() would spend the limiter's budget on this
  // file's own assertions. Upload ownership is per-user and none of these tests
  // assert on cross-user isolation, so one uploader is enough.
  let uploader;
  const asUploader = async () => {
    if (!uploader) uploader = await signup();
    return asUser(uploader.token);
  };

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
      .attach('photo', PNG_1x1, { filename: 'photo.png', contentType: 'image/png' });

    expect(res.status).toBe(200);
    // The v0.0.2 bug: filename extension came from the client, so an .svg
    // became a same-origin script execution vector.
    expect(res.body.url).toMatch(/\.png$/);
  });

  it('does not serve uploads without authentication', async () => {
    const res = await request(app).get('/uploads/anything.png');
    expect([401, 403, 404]).toContain(res.status);
  });

  // --- plan step 21: content-based validation -------------------------------
  //
  // Everything below fails against the v0.0.2 pipeline, which accepted whatever
  // bytes arrived as long as the client *said* the right Content-Type.

  it('rejects a file that only claims to be a PNG', async () => {
    const auth = await asUploader();
    const before = fs.readdirSync(uploadDir);

    const res = await request(app)
      .post('/api/photos/upload')
      .set(auth)
      .attach('photo', Buffer.from('<script>alert(1)</script>'), {
        filename: 'innocent.png',
        contentType: 'image/png',
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/not a supported image/i);
    // Fail closed: a rejected upload leaves nothing behind on disk.
    expect(fs.readdirSync(uploadDir)).toEqual(before);
  });

  it('strips a payload appended after a valid image', async () => {
    // A magic-byte check alone cannot see this: the PNG is genuinely valid and
    // the <script> lives after IEND. Re-encoding is what makes it harmless — the
    // stored file is rebuilt from decoded pixels, so the trailer does not survive.
    const auth = await asUploader();
    const res = await request(app)
      .post('/api/photos/upload')
      .set(auth)
      .attach('photo', Buffer.concat([PNG_1x1, Buffer.from('<script>alert(1)</script>')]), {
        filename: 'polyglot.png',
        contentType: 'image/png',
      });

    expect(res.status).toBe(200);
    const stored = fs.readFileSync(storedPath(res.body.url));
    expect(stored.includes(Buffer.from('<script>'))).toBe(false);
    expect((await sharp(stored).metadata()).format).toBe('png');
  });

  it('rejects a PNG header whose payload is truncated away', async () => {
    const auth = await asUploader();
    const res = await request(app)
      .post('/api/photos/upload')
      .set(auth)
      // Correct magic bytes, nothing behind them: the signature alone is not
      // an image, and the old pipeline stored it as one.
      .attach('photo', Buffer.from('89504e470d0a1a0a', 'hex'), {
        filename: 'header-only.png',
        contentType: 'image/png',
      });

    expect(res.status).toBe(400);
  });

  it('accepts an image that only claims to be something else', async () => {
    // The mirror image of the attack above: real PNG bytes, a header that says
    // nothing useful. The old fileFilter rejected it on the client's word alone;
    // the new pipeline decides from the bytes.
    const auth = await asUploader();
    const res = await request(app)
      .post('/api/photos/upload')
      .set(auth)
      .attach('photo', PNG_1x1, { filename: 'photo.png', contentType: 'application/octet-stream' });

    expect(res.status).toBe(200);
    expect(res.body.url).toMatch(/\.png$/);
  });

  it('stores a valid PNG that is still a valid PNG after re-encoding', async () => {
    const auth = await asUploader();
    const res = await request(app)
      .post('/api/photos/upload')
      .set(auth)
      .attach('photo', PNG_1x1, { filename: 'photo.png', contentType: 'image/png' });

    expect(res.status).toBe(200);
    const stored = fs.readFileSync(storedPath(res.body.url));
    // Magic bytes survive; the file is decodable, not just correctly named.
    expect(stored.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    const meta = await sharp(stored).metadata();
    expect(meta.format).toBe('png');
    expect(meta.width).toBe(1);
    expect(meta.height).toBe(1);
  });

  it('strips EXIF and GPS from the stored image', async () => {
    const auth = await asUploader();
    const withExif = await sharp({
      create: { width: 8, height: 8, channels: 3, background: { r: 12, g: 34, b: 56 } },
    })
      .withExifMerge({
        IFD0: { Copyright: 'penpal' },
        IFD3: { GPSLatitudeRef: 'N', GPSLatitude: '51/1 30/1 0/1' },
      })
      .png()
      .toBuffer();
    // Sanity check the fixture itself, so a green test cannot be a vacuous one.
    expect((await sharp(withExif).metadata()).exif).toBeTruthy();

    const res = await request(app)
      .post('/api/photos/upload')
      .set(auth)
      .attach('photo', withExif, { filename: 'phone-photo.png', contentType: 'image/png' });

    expect(res.status).toBe(200);
    const stored = fs.readFileSync(storedPath(res.body.url));
    expect((await sharp(stored).metadata()).exif ?? Buffer.alloc(0)).toHaveLength(0);
    expect(stored.includes(Buffer.from('GPS'))).toBe(false);
    // The thumbnail is a separate file and gets the same treatment.
    const thumb = fs.readFileSync(storedPath(res.body.thumbUrl));
    expect((await sharp(thumb).metadata()).exif ?? Buffer.alloc(0)).toHaveLength(0);
  });

  it('returns a thumbnail URL alongside the image URL', async () => {
    const auth = await asUploader();
    const res = await request(app)
      .post('/api/photos/upload')
      .set(auth)
      .attach('photo', PNG_1x1, { filename: 'photo.png', contentType: 'image/png' });

    expect(res.status).toBe(200);
    expect(typeof res.body.id).toBe('number');
    expect(res.body.thumbUrl).toMatch(/_thumb\.png$/);
    const thumb = fs.readFileSync(storedPath(res.body.thumbUrl));
    expect(thumb.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    // The thumbnail is served behind auth like everything else in /uploads.
    expect((await request(app).get(res.body.thumbUrl)).status).toBe(401);
  });

  it('rejects an image whose pixel count is absurd', async () => {
    const auth = await asUploader();
    // A real PNG header claiming 9000x9000 — over the 8000px ceiling and over
    // the total pixel budget, without allocating 81 megapixels in the test.
    const bomb = Buffer.from(PNG_1x1);
    bomb.writeUInt32BE(9000, 16);
    bomb.writeUInt32BE(9000, 20);
    const before = fs.readdirSync(uploadDir);

    const res = await request(app)
      .post('/api/photos/upload')
      .set(auth)
      .attach('photo', bomb, { filename: 'bomb.png', contentType: 'image/png' });

    expect(res.status).toBe(400);
    expect(fs.readdirSync(uploadDir)).toEqual(before);
  });

  it('rejects an upload over 10MB', async () => {
    const auth = await asUploader();
    const oversize = Buffer.concat([PNG_1x1, Buffer.alloc(11 * 1024 * 1024, 0x41)]);
    const res = await request(app)
      .post('/api/photos/upload')
      .set(auth)
      .attach('photo', oversize, { filename: 'big.png', contentType: 'image/png' });

    expect(res.status).toBe(400);
  });
});
// ---------------------------------------------------------------------------
// Who may read a photo (plan step 19)
//
// Photos are the one thing in this app that is NOT end-to-end encrypted — they
// sit on disk in plaintext. That makes the authorisation here the only thing
// between a photograph and every other account on the instance.
//
// The previous version required a valid token and nothing more, so any signed-in
// user who learned a URL could read anybody's photos. For an app whose entire
// premise is that it is between two people, that is the product failing, not a
// missing feature.
// ---------------------------------------------------------------------------
describe('photo authorisation', () => {
  const PNG_1x1 = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64',
  );

  const upload = async (token) => {
    const res = await request(app)
      .post('/api/photos/upload')
      .set(asUser(token))
      .attach('photo', PNG_1x1, { filename: 'p.png', contentType: 'image/png' });
    expect(res.status).toBe(200);
    return res.body; // { id, url: '/uploads/<uuid>.png', thumbUrl }
  };

  it('lets the uploader read their own photo', async () => {
    const a = await signup();
    const photo = await upload(a.token);

    const res = await request(app).get(photo.url).set(asUser(a.token));
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/image\//);
  });

  it('lets the uploader read their own thumbnail', async () => {
    const a = await signup();
    const photo = await upload(a.token);

    const res = await request(app).get(photo.thumbUrl).set(asUser(a.token));
    expect(res.status).toBe(200);
  });

  it('refuses a signed-in stranger', async () => {
    const a = await signup();
    const stranger = await signup();
    const photo = await upload(a.token);

    const res = await request(app).get(photo.url).set(asUser(stranger.token));
    expect(res.status).toBe(404);
  });

  it('refuses an anonymous request', async () => {
    const a = await signup();
    const photo = await upload(a.token);

    const res = await request(app).get(photo.url);
    expect([401, 403, 404]).toContain(res.status);
  });

  it('does not confirm that a forbidden photo exists', async () => {
    // 404 rather than 403, deliberately: a 403 tells an attacker the file is
    // real, which turns the upload directory into an enumeration oracle. A
    // stranger and a nonexistent filename must be indistinguishable.
    const a = await signup();
    const stranger = await signup();
    const photo = await upload(a.token);

    const forbidden = await request(app).get(photo.url).set(asUser(stranger.token));
    const missing = await request(app)
      .get('/uploads/00000000-0000-4000-8000-000000000000.png')
      .set(asUser(stranger.token));

    expect(forbidden.status).toBe(missing.status);
    expect(forbidden.body).toEqual(missing.body);
  });

  it('refuses the pen pal until the photo is attached to a letter', async () => {
    const { a, b } = await pairedCouple();
    const photo = await upload(a.token);

    // Paired is not the same as attached. Nothing sets photos.letter_id yet, so
    // this must still be refused — sharing is impossible until it is, which is
    // the safe direction to be wrong in.
    const before = await request(app).get(photo.url).set(asUser(b.token));
    expect(before.status).toBe(404);

    const { getDb } = await import('../server/db.js');
    const sent = await request(app)
      .post('/api/letters/send')
      .set(asUser(a.token))
      .send({
        recipientId: b.user.id,
        encryptedContent: '{"v":2,"ct":"AAAA"}',
        encryptedMetadata: '{"v":2,"ct":"BBBB"}',
        idempotencyKey: `photo-auth-${Date.now()}`,
      });
    expect(sent.status).toBe(200);
    expect(sent.body.success).toBe(true);

    getDb()
      .prepare('UPDATE photos SET letter_id = ? WHERE id = ?')
      .run(sent.body.letter.id, photo.id);

    const after = await request(app).get(photo.url).set(asUser(b.token));
    expect(after.status).toBe(200);
    expect(after.headers['content-type']).toMatch(/image\//);
  });

  it('still refuses a stranger after the photo is attached', async () => {
    const { a } = await pairedCouple();
    const stranger = await signup();
    const photo = await upload(a.token);

    const { getDb } = await import('../server/db.js');
    getDb()
      .prepare('UPDATE photos SET letter_id = (SELECT id FROM letters LIMIT 1) WHERE id = ?')
      .run(photo.id);

    const res = await request(app).get(photo.url).set(asUser(stranger.token));
    expect(res.status).toBe(404);
  });

  it('serves nothing but the pipeline output', async () => {
    const a = await signup();
    const photo = await upload(a.token);

    const res = await request(app).get(photo.url).set(asUser(a.token));
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    // Directory listings were never available and must not become available.
    const dir = await request(app).get('/uploads/').set(asUser(a.token));
    expect(dir.status).toBeGreaterThanOrEqual(400);
  });

  // A note on what these assert, because the obvious assertion is the wrong one.
  // `/uploads/../../server/index.js` does NOT return the server source — the
  // client normalises the `..` away, the path becomes `/server/index.js`, and
  // that matches the SPA fallback, which answers 200 with the CLIENT's
  // index.html. So "status >= 400" fails against a perfectly safe response, and
  // asserting on status would have pushed someone toward making the fallback
  // return 404 for paths it never had any business serving in the first place.
  //
  // What actually matters is that no response body ever contains a file from
  // outside the upload directory. That is asserted directly.
  const SOURCE_MARKERS = /require\(|JWT_SECRET|express\.Router|runMigrations|penpal-e2e-only/;

  it.each([
    ['dot-dot traversal', '/uploads/../../server/index.js'],
    ['encoded traversal', '/uploads/..%2f..%2fserver%2findex.js'],
    ['double-encoded traversal', '/uploads/..%252f..%252fserver/db.js'],
    ['a non-uuid filename', '/uploads/penpal.db'],
    ['a nested path', '/uploads/sub/dir/00000000-0000-4000-8000-000000000000.png'],
    ['a dotfile', '/uploads/.00000000-0000-4000-8000-000000000000.png'],
    ['an absolute path', '/uploads//etc/passwd'],
  ])('serves no source file for %s', async (_label, target) => {
    const a = await signup();
    const res = await request(app).get(target).set(asUser(a.token));
    expect(res.text ?? '').not.toMatch(SOURCE_MARKERS);
    // And it must never be the database either.
    expect(res.text ?? '').not.toMatch(/SQLite format 3/);
  });
});
