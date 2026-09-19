// Port of public/crypto.js (RSA-OAEP 2048 + AES-GCM 256 + PBKDF2) with fixes:
// - chunked base64 (no btoa(...spread) stack risk)
// - salt passed as Uint8Array bytes directly (not enc.encode(salt.toString()))
// - secure-context guard

const te = new TextEncoder();
const td = new TextDecoder();

function subtle(): SubtleCrypto {
  const c = globalThis.crypto as Crypto | undefined;
  if (!c?.subtle)
    throw new Error('WebCrypto unavailable — needs a secure context (https or localhost)');
  return c.subtle;
}

export function bytesToB64(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000)
    bin += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + 0x8000)));
  return btoa(bin);
}

export function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

const RSA = { name: 'RSA-OAEP', hash: 'SHA-256' } as const;

export async function generateKeyPair(): Promise<CryptoKeyPair> {
  return subtle().generateKey(
    { name: 'RSA-OAEP', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['encrypt', 'decrypt'],
  );
}

export async function exportKey(key: CryptoKey): Promise<JsonWebKey> {
  return subtle().exportKey('jwk', key);
}

export async function importPublicKey(jwk: JsonWebKey): Promise<CryptoKey> {
  return subtle().importKey('jwk', jwk, RSA, true, ['encrypt']);
}

export async function importPrivateKey(jwk: JsonWebKey): Promise<CryptoKey> {
  return subtle().importKey('jwk', jwk, RSA, true, ['decrypt']);
}

export async function deriveKeyFromPassword(password: string, salt: Uint8Array): Promise<CryptoKey> {
  const material = await subtle().importKey('raw', te.encode(password), 'PBKDF2', false, [
    'deriveBits',
    'deriveKey',
  ]);
  return subtle().deriveKey(
    { name: 'PBKDF2', salt: salt as BufferSource, iterations: 100000, hash: 'SHA-256' },
    material,
    { name: 'AES-GCM', length: 256 },
    true,
    ['encrypt', 'decrypt'],
  );
}

export interface WrappedPrivateKey {
  encryptedData: string;
  iv: string;
  salt: string;
}

export async function encryptPrivateKey(jwk: JsonWebKey, password: string): Promise<WrappedPrivateKey> {
  const salt = globalThis.crypto.getRandomValues(new Uint8Array(16));
  const key = await deriveKeyFromPassword(password, salt);
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const ct = await subtle().encrypt({ name: 'AES-GCM', iv: iv as BufferSource }, key, te.encode(JSON.stringify(jwk)));
  return { encryptedData: bytesToB64(new Uint8Array(ct)), iv: bytesToB64(iv), salt: bytesToB64(salt) };
}

export async function decryptPrivateKey(wrapped: WrappedPrivateKey, password: string): Promise<JsonWebKey> {
  const key = await deriveKeyFromPassword(password, b64ToBytes(wrapped.salt));
  const pt = await subtle().decrypt(
    { name: 'AES-GCM', iv: b64ToBytes(wrapped.iv) as BufferSource },
    key,
    b64ToBytes(wrapped.encryptedData),
  );
  return JSON.parse(td.decode(pt)) as JsonWebKey;
}

export interface EncryptedLetter {
  content: string;
  iv: string;
  recipientKey: string;
  senderKey: string;
}

export async function encryptLetter(
  content: string,
  recipientJWK: JsonWebKey,
  senderJWK: JsonWebKey,
): Promise<EncryptedLetter> {
  const aesKey = await subtle().generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const ct = await subtle().encrypt({ name: 'AES-GCM', iv: iv as BufferSource }, aesKey, te.encode(content));
  const raw = await subtle().exportKey('raw', aesKey);
  const [rKey, sKey] = await Promise.all([importPublicKey(recipientJWK), importPublicKey(senderJWK)]);
  const [forR, forS] = await Promise.all([
    subtle().encrypt({ name: 'RSA-OAEP' }, rKey, raw),
    subtle().encrypt({ name: 'RSA-OAEP' }, sKey, raw),
  ]);
  return {
    content: bytesToB64(new Uint8Array(ct)),
    iv: bytesToB64(iv),
    recipientKey: bytesToB64(new Uint8Array(forR)),
    senderKey: bytesToB64(new Uint8Array(forS)),
  };
}

export async function decryptLetter(
  bundle: EncryptedLetter,
  privateKey: CryptoKey,
  isSender: boolean,
): Promise<string> {
  const wrappedKey = b64ToBytes(isSender ? bundle.senderKey : bundle.recipientKey);
  const raw = await subtle().decrypt({ name: 'RSA-OAEP' }, privateKey, wrappedKey as BufferSource);
  const aesKey = await subtle().importKey('raw', raw, 'AES-GCM', true, ['decrypt']);
  const pt = await subtle().decrypt(
    { name: 'AES-GCM', iv: b64ToBytes(bundle.iv) as BufferSource },
    aesKey,
    b64ToBytes(bundle.content),
  );
  return td.decode(pt);
}
