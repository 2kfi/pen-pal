/**
 * E2E crypto for PenPal letters.
 *
 * Design notes (this file was theatre in v0.0.2 — exported functions nobody called):
 *
 *   - Scheme: per-letter AES-256-GCM key, wrapped once per participant with
 *     RSA-OAEP-2048/SHA-256. Sender keeps a copy so they can re-read their own letters.
 *   - The user's private key never leaves the client. At rest it is AES-GCM wrapped
 *     under PBKDF2-SHA256(password) and the *only* copy the server holds.
 *   - Every letter envelope is versioned and carries AAD binding sender, recipient
 *     and timestamp. Without that, an attacker with DB write access could splice a
 *     valid ciphertext from one (sender, recipient) pair onto another letter row and
 *     both sides would happily decrypt it. AAD makes that forgery fail closed.
 *   - Decryption errors are surfaced, never swallowed. Compose MUST NOT be able to
 *     fall back to shipping plaintext (that was the v0.0.2 bug).
 */

const te = new TextEncoder();
const td = new TextDecoder();

/** Current envelope version. Bump when the wire format changes incompatibly. */
export const ENVELOPE_VERSION = 2;

/** Params used for wrapping/unwrapping the private key. Stored so PBKDF2 can be upgraded later. */
export const KEY_WRAP_PARAMS = Object.freeze({
  name: 'PBKDF2' as const,
  hash: 'SHA-256' as const,
  iterations: 600_000,
});

const RSA = { name: 'RSA-OAEP', hash: 'SHA-256' } as const;

/**
 * WebCrypto is only exposed in a secure context. Self-hosted PenPal is very often
 * reached over plain http://192.168.x.x, where `crypto.subtle` is undefined and
 * silently unavailable.
 *
 * We refuse to run rather than degrade. Falling back to plaintext would be worse
 * than a hard failure, so this throws and the UI surfaces it as an explicit
 * "serve this over HTTPS" message.
 */
export function isCryptoAvailable(): boolean {
  return typeof globalThis.crypto?.subtle?.importKey === 'function';
}

export class SecureContextError extends Error {
  constructor() {
    super(
      'Encryption is unavailable: this page is not a secure context. ' +
        'Serve PenPal over HTTPS (or localhost) — WebCrypto refuses to run otherwise, ' +
        'and we will not fall back to sending your letters unencrypted.',
    );
    this.name = 'SecureContextError';
  }
}

function subtle(): SubtleCrypto {
  if (!isCryptoAvailable()) throw new SecureContextError();
  return globalThis.crypto.subtle;
}

/* ------------------------------------------------------------------ *
 * base64 (chunked — btoa(String.fromCharCode(...bytes)) blows the      *
 * argument limit around 100k elements and letters can exceed that)   *
 * ------------------------------------------------------------------ */

export function bytesToB64(bytes: Uint8Array): string {
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

export function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/* ------------------------------------------------------------------ *
 * keys                                                                *
 * ------------------------------------------------------------------ */

export function generateKeyPair(): Promise<CryptoKeyPair> {
  return subtle().generateKey(
    { name: 'RSA-OAEP', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['encrypt', 'decrypt'],
  );
}

export function exportKey(key: CryptoKey): Promise<JsonWebKey> {
  return subtle().exportKey('jwk', key);
}

export function exportPublicKey(key: CryptoKey): Promise<JsonWebKey> {
  return subtle().exportKey('jwk', key);
}

export function importPublicKey(jwk: JsonWebKey): Promise<CryptoKey> {
  return subtle().importKey('jwk', jwk, RSA, true, ['encrypt']);
}

export function importPrivateKey(jwk: JsonWebKey): Promise<CryptoKey> {
  return subtle().importKey('jwk', jwk, RSA, true, ['decrypt']);
}

/* ------------------------------------------------------------------ *
 * private-key wrapping (password → AES-GCM → wrapped private JWK)     *
 * ------------------------------------------------------------------ */

export interface WrappedPrivateKey {
  v: number;
  kdf: string;
  hash: string;
  iterations: number;
  salt: string;
  iv: string;
  data: string;
}

export async function deriveWrappingKey(password: string, salt: Uint8Array): Promise<CryptoKey> {
  const material = await subtle().importKey('raw', te.encode(password), KEY_WRAP_PARAMS.name, false, [
    'deriveKey',
  ]);
  return subtle().deriveKey(
    { name: KEY_WRAP_PARAMS.name, salt: salt as BufferSource, iterations: KEY_WRAP_PARAMS.iterations, hash: KEY_WRAP_PARAMS.hash },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

export async function wrapPrivateKey(privateJwk: JsonWebKey, password: string): Promise<WrappedPrivateKey> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveWrappingKey(password, salt);
  const ct = await subtle().encrypt({ name: 'AES-GCM', iv: iv as BufferSource }, key, te.encode(JSON.stringify(privateJwk)));
  return {
    v: ENVELOPE_VERSION,
    kdf: KEY_WRAP_PARAMS.name,
    hash: KEY_WRAP_PARAMS.hash,
    iterations: KEY_WRAP_PARAMS.iterations,
    salt: bytesToB64(salt),
    iv: bytesToB64(iv),
    data: bytesToB64(new Uint8Array(ct)),
  };
}

export class WrongPasswordError extends Error {
  constructor() {
    super('That password does not unlock this key.');
    this.name = 'WrongPasswordError';
  }
}

/** Throws {@link WrongPasswordError} on a bad password — AES-GCM auth tag failure. */
export async function unwrapPrivateKey(wrapped: WrappedPrivateKey, password: string): Promise<JsonWebKey> {
  const key = await deriveWrappingKey(password, b64ToBytes(wrapped.salt));
  let pt: ArrayBuffer;
  try {
    pt = await subtle().decrypt({ name: 'AES-GCM', iv: b64ToBytes(wrapped.iv) as BufferSource }, key, b64ToBytes(wrapped.data));
  } catch {
    throw new WrongPasswordError();
  }
  return JSON.parse(td.decode(pt)) as JsonWebKey;
}

/* ------------------------------------------------------------------ *
 * letter envelopes                                                    *
 * ------------------------------------------------------------------ */

/** The shape persisted in `letters.encrypted_content`. */
export interface LetterEnvelope {
  v: number;
  /** AES-GCM ciphertext, base64. */
  ct: string;
  /** 12-byte IV, base64. */
  iv: string;
  /** Wrapped content keys, keyed by user id, base64. */
  keys: Record<string, string>;
  /** Bound into the AES-GCM AAD so the envelope cannot be re-addressed. */
  senderId: number;
  recipientId: number;
  /** ISO-8601. */
  sentAt: string;
}

/**
 * Deterministic AAD. Both sides derive the same string from data already in the
 * envelope header, so decryption fails if the header was tampered with.
 */
function aad(env: Pick<LetterEnvelope, 'v' | 'senderId' | 'recipientId' | 'sentAt'>): Uint8Array {
  return te.encode(`penpal:v${env.v}:${env.senderId}:${env.recipientId}:${env.sentAt}`);
}

export class DecryptionError extends Error {
  /** The underlying WebCrypto failure, kept for logging. Never surfaced to users —
   * it distinguishes "wrong key" from "tampered ciphertext", which is an oracle. */
  readonly cause: unknown;

  constructor(cause?: unknown) {
    super('This letter could not be decrypted. It may belong to a different pairing.');
    this.name = 'DecryptionError';
    this.cause = cause;
  }
}

export interface SealOptions {
  senderId: number;
  recipientId: number;
  /** Public key of the recipient. */
  recipientPublicKey: JsonWebKey;
  /** Public key of the sender, so they can read their own letter back later. */
  senderPublicKey: JsonWebKey;
  sentAt: string;
}

export async function sealLetter(plaintext: string, opts: SealOptions): Promise<LetterEnvelope> {
  const contentKey = await subtle().generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const header = {
    v: ENVELOPE_VERSION,
    senderId: opts.senderId,
    recipientId: opts.recipientId,
    sentAt: opts.sentAt,
  };

  const ct = await subtle().encrypt(
    { name: 'AES-GCM', iv: iv as BufferSource, additionalData: aad(header) as BufferSource },
    contentKey,
    te.encode(plaintext),
  );

  const raw = await subtle().exportKey('raw', contentKey);
  const [rk, sk] = await Promise.all([importPublicKey(opts.recipientPublicKey), importPublicKey(opts.senderPublicKey)]);

  const keys: Record<string, string> = {};
  // Wrapped to BOTH parties. The sender copy is not optional: without it you can
  // never re-read a letter you sent, which makes the archive a one-way street.
  const [forRecipient, forSender] = await Promise.all([
    subtle().encrypt({ name: 'RSA-OAEP' }, rk, raw),
    subtle().encrypt({ name: 'RSA-OAEP' }, sk, raw),
  ]);
  keys[String(opts.recipientId)] = bytesToB64(new Uint8Array(forRecipient));
  keys[String(opts.senderId)] = bytesToB64(new Uint8Array(forSender));

  return { ...header, iv: bytesToB64(iv), ct: bytesToB64(new Uint8Array(ct)), keys };
}

export async function openLetter(envelope: LetterEnvelope, privateKey: CryptoKey, viewerId: number): Promise<string> {
  if (envelope.v !== ENVELOPE_VERSION) throw new DecryptionError();
  const wrapped = envelope.keys[String(viewerId)];
  if (!wrapped) throw new DecryptionError();

  let raw: ArrayBuffer;
  try {
    raw = await subtle().decrypt({ name: 'RSA-OAEP' }, privateKey, b64ToBytes(wrapped) as BufferSource);
  } catch {
    throw new DecryptionError();
  }

  const contentKey = await subtle().importKey('raw', raw, 'AES-GCM', true, ['decrypt']);
  try {
    const pt = await subtle().decrypt(
      { name: 'AES-GCM', iv: b64ToBytes(envelope.iv) as BufferSource, additionalData: aad(envelope) as BufferSource },
      contentKey,
      b64ToBytes(envelope.ct),
    );
    return td.decode(pt);
  } catch (err) {
    throw new DecryptionError(err);
  }
}

/** Cheap structural check so the UI can say "sealed" without attempting decryption. */
export function isEnvelope(value: unknown): value is LetterEnvelope {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Partial<LetterEnvelope>;
  return (
    v.v === ENVELOPE_VERSION &&
    typeof v.ct === 'string' &&
    typeof v.iv === 'string' &&
    typeof v.senderId === 'number' &&
    typeof v.recipientId === 'number' &&
    typeof v.sentAt === 'string' &&
    typeof v.keys === 'object' &&
    v.keys !== null
  );
}