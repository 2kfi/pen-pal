import { describe, it, expect } from 'vitest';
import {
  ENVELOPE_VERSION,
  DecryptionError,
  WrongPasswordError,
  exportKey,
  generateKeyPair,
  isEnvelope,
  openLetter,
  sealLetter,
  unwrapPrivateKey,
  wrapPrivateKey,
} from './crypto';

/**
 * These are the tests that would have caught the v0.0.2 catastrophe: the crypto
 * module shipped four exported functions that no caller ever invoked, so nothing
 * ever verified that a letter could actually be sealed or opened.
 */

async function makeIdentity() {
  const pair = await generateKeyPair();
  return {
    id: Math.floor(Math.random() * 1_000_000),
    publicJwk: await exportKey(pair.publicKey),
    privateKey: pair.privateKey,
  };
}

const NOW = '2026-10-13T12:00:00.000Z';
const TEXT = 'Dear Sam,\n\nthe sea here is very cold and very loud.\n\n— R';

describe('key wrapping', () => {
  it('round-trips a private key through PBKDF2 + AES-GCM', async () => {
    const pair = await generateKeyPair();
    const jwk = await exportKey(pair.privateKey);

    const wrapped = await wrapPrivateKey(jwk, 'correct horse battery staple');
    const unwrapped = await unwrapPrivateKey(wrapped, 'correct horse battery staple');

    expect(unwrapped).toEqual(jwk);
  });

  it('rejects the wrong password with WrongPasswordError', async () => {
    const pair = await generateKeyPair();
    const wrapped = await exportKey(pair.privateKey).then((jwk) => wrapPrivateKey(jwk, 'right'));

    await expect(unwrapPrivateKey(wrapped, 'wrong')).rejects.toBeInstanceOf(WrongPasswordError);
  });

  it('records KDF parameters so the cost can be raised later without breaking old keys', async () => {
    const pair = await generateKeyPair();
    const wrapped = await wrapPrivateKey(await exportKey(pair.privateKey), 'pw');

    expect(wrapped.kdf).toBe('PBKDF2');
    expect(wrapped.hash).toBe('SHA-256');
    expect(wrapped.iterations).toBeGreaterThanOrEqual(600_000);
  });

  it('produces a different salt and IV every time', async () => {
    const pair = await generateKeyPair();
    const jwk = await exportKey(pair.privateKey);
    const a = await wrapPrivateKey(jwk, 'pw');
    const b = await wrapPrivateKey(jwk, 'pw');

    expect(a.salt).not.toBe(b.salt);
    expect(a.iv).not.toBe(b.iv);
    expect(a.data).not.toBe(b.data);
  });
});

describe('letter envelopes', () => {
  it('produces a structurally valid envelope', async () => {
    const sender = await makeIdentity();
    const recipient = await makeIdentity();

    const env = await sealLetter(TEXT, {
      senderId: sender.id,
      recipientId: recipient.id,
      recipientPublicKey: recipient.publicJwk,
      senderPublicKey: sender.publicJwk,
      sentAt: NOW,
    });

    expect(isEnvelope(env)).toBe(true);
    expect(env.v).toBe(ENVELOPE_VERSION);
    expect(env.keys[String(sender.id)]).toBeTruthy();
    expect(env.keys[String(recipient.id)]).toBeTruthy();
  });

  it('round-trips for the recipient', async () => {
    const sender = await makeIdentity();
    const recipient = await makeIdentity();

    const env = await sealLetter(TEXT, {
      senderId: sender.id,
      recipientId: recipient.id,
      recipientPublicKey: recipient.publicJwk,
      senderPublicKey: sender.publicJwk,
      sentAt: NOW,
    });

    const opened = await openLetter(env, recipient.privateKey, recipient.id);
    expect(opened).toBe(TEXT);
  });

  it('round-trips for the sender, so you can re-read what you sent', async () => {
    const sender = await makeIdentity();
    const recipient = await makeIdentity();

    const env = await sealLetter(TEXT, {
      senderId: sender.id,
      recipientId: recipient.id,
      recipientPublicKey: recipient.publicJwk,
      senderPublicKey: sender.publicJwk,
      sentAt: NOW,
    });

    const opened = await openLetter(env, sender.privateKey, sender.id);
    expect(opened).toBe(TEXT);
  });

  it('refuses to open for anyone else — a third party with their own key gets nothing', async () => {
    const sender = await makeIdentity();
    const recipient = await makeIdentity();
    const stranger = await makeIdentity();

    const env = await sealLetter(TEXT, {
      senderId: sender.id,
      recipientId: recipient.id,
      recipientPublicKey: recipient.publicJwk,
      senderPublicKey: sender.publicJwk,
      sentAt: NOW,
    });

    await expect(openLetter(env, stranger.privateKey, stranger.id)).rejects.toBeInstanceOf(DecryptionError);
  });

  it('fails closed when the ciphertext is altered', async () => {
    const sender = await makeIdentity();
    const recipient = await makeIdentity();

    const env = await sealLetter(TEXT, {
      senderId: sender.id,
      recipientId: recipient.id,
      recipientPublicKey: recipient.publicJwk,
      senderPublicKey: sender.publicJwk,
      sentAt: NOW,
    });

    // Flip one base64 character of the ciphertext.
    const bytes = env.ct.split('');
    bytes[0] = bytes[0] === 'A' ? 'B' : 'A';

    await expect(
      openLetter({ ...env, ct: bytes.join('') }, recipient.privateKey, recipient.id),
    ).rejects.toBeInstanceOf(DecryptionError);
  });

  it('rejects an envelope re-addressed to a different recipient (AAD binding)', async () => {
    const sender = await makeIdentity();
    const recipient = await makeIdentity();
    const attacker = await makeIdentity();

    const env = await sealLetter(TEXT, {
      senderId: sender.id,
      recipientId: recipient.id,
      recipientPublicKey: recipient.publicJwk,
      senderPublicKey: sender.publicJwk,
      sentAt: NOW,
    });

    // An attacker with DB write access rewrites the header to claim the letter was
    // sent to them. Without AAD this would decrypt; with it, the auth tag fails.
    const forged = { ...env, recipientId: attacker.id };

    await expect(
      openLetter(forged, recipient.privateKey, recipient.id),
    ).rejects.toBeInstanceOf(DecryptionError);
  });

  it('rejects an envelope whose senderId was tampered with', async () => {
    const sender = await makeIdentity();
    const recipient = await makeIdentity();

    const env = await sealLetter(TEXT, {
      senderId: sender.id,
      recipientId: recipient.id,
      recipientPublicKey: recipient.publicJwk,
      senderPublicKey: sender.publicJwk,
      sentAt: NOW,
    });

    await expect(
      openLetter({ ...env, senderId: sender.id + 1 }, recipient.privateKey, recipient.id),
    ).rejects.toBeInstanceOf(DecryptionError);
  });

  it('rejects an unknown envelope version', async () => {
    const sender = await makeIdentity();
    const recipient = await makeIdentity();

    const env = await sealLetter(TEXT, {
      senderId: sender.id,
      recipientId: recipient.id,
      recipientPublicKey: recipient.publicJwk,
      senderPublicKey: sender.publicJwk,
      sentAt: NOW,
    });

    await expect(
      openLetter({ ...env, v: 99 }, recipient.privateKey, recipient.id),
    ).rejects.toBeInstanceOf(DecryptionError);
  });

  it('never leaks plaintext into the envelope', async () => {
    const sender = await makeIdentity();
    const recipient = await makeIdentity();

    const env = await sealLetter(TEXT, {
      senderId: sender.id,
      recipientId: recipient.id,
      recipientPublicKey: recipient.publicJwk,
      senderPublicKey: sender.publicJwk,
      sentAt: NOW,
    });

    const serialised = JSON.stringify(env);
    expect(serialised).not.toContain('Dear Sam');
    expect(serialised).not.toContain('the sea here is very cold');
  });

  it('rejects non-envelope payloads', () => {
    expect(isEnvelope(null)).toBe(false);
    expect(isEnvelope('hello')).toBe(false);
    expect(isEnvelope({ v: 1 })).toBe(false);
    expect(isEnvelope({ ...{ v: ENVELOPE_VERSION }, ct: 'x', iv: 'x', senderId: 1, recipientId: 2, sentAt: NOW, keys: {} })).toBe(true);
  });
});