import { describe, expect, it } from 'vitest';
import {
  decryptLetter,
  decryptPrivateKey,
  encryptLetter,
  encryptPrivateKey,
  exportKey,
  generateKeyPair,
  importPrivateKey,
} from './crypto';

describe('crypto round-trip', () => {
  it('encryptLetter decrypts with both recipient and sender keys', async () => {
    const [a, b] = await Promise.all([generateKeyPair(), generateKeyPair()]);
    const [aPub, bPub] = await Promise.all([exportKey(a.publicKey), exportKey(b.publicKey)]);
    const bundle = await encryptLetter('hello penpal', bPub, aPub);
    const [asRecipient, asSender] = await Promise.all([
      decryptLetter(bundle, b.privateKey, false),
      decryptLetter(bundle, a.privateKey, true),
    ]);
    expect(asRecipient).toBe('hello penpal');
    expect(asSender).toBe('hello penpal');
  });

  it('encryptPrivateKey round-trips through PBKDF2', async () => {
    const pair = await generateKeyPair();
    const jwk = await exportKey(pair.privateKey);
    const wrapped = await encryptPrivateKey(jwk, 'correct horse');
    const back = await decryptPrivateKey(wrapped, 'correct horse');
    expect(back).toEqual(jwk);
    const priv = await importPrivateKey(back);
    expect(priv.type).toBe('private');
  });
});
