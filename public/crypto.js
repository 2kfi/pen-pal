// public/crypto.js

/**
 * E2E Encryption Utility for PenPal Archive
 * Uses RSA-OAEP for key exchange and AES-GCM for content encryption.
 */

const CryptoUtils = {
  // Generate RSA-OAEP Key Pair
  async generateKeyPair() {
    const keyPair = await window.crypto.subtle.generateKey(
      {
        name: "RSA-OAEP",
        modulusLength: 2048,
        publicExponent: new Uint8Array([1, 0, 1]),
        hash: "SHA-256",
      },
      true,
      ["encrypt", "decrypt"]
    );
    return keyPair;
  },

  // Export Key to JWK (for storage)
  async exportKey(key) {
    return await window.crypto.subtle.exportKey("jwk", key);
  },

  // Import Key from JWK
  async importPublicKey(jwk) {
    return await window.crypto.subtle.importKey(
      "jwk",
      jwk,
      {
        name: "RSA-OAEP",
        hash: "SHA-256",
      },
      true,
      ["encrypt"]
    );
  },

  async importPrivateKey(jwk) {
    return await window.crypto.subtle.importKey(
      "jwk",
      jwk,
      {
        name: "RSA-OAEP",
        hash: "SHA-256",
      },
      true,
      ["decrypt"]
    );
  },

  // Derive a key from password (PBKDF2) to encrypt the private key
  async deriveKeyFromPassword(password, salt) {
    const enc = new TextEncoder();
    const keyMaterial = await window.crypto.subtle.importKey(
      "raw",
      enc.encode(password),
      "PBKDF2",
      false,
      ["deriveBits", "deriveKey"]
    );
    return await window.crypto.subtle.deriveKey(
      {
        name: "PBKDF2",
        salt: enc.encode(salt),
        iterations: 100000,
        hash: "SHA-256",
      },
      keyMaterial,
      { name: "AES-GCM", length: 256 },
      true,
      ["encrypt", "decrypt"]
    );
  },

  // Encrypt Private Key with Password-derived Key
  async encryptPrivateKey(privateKeyJwk, password) {
    const salt = window.crypto.getRandomValues(new Uint8Array(16));
    const derivedKey = await this.deriveKeyFromPassword(password, salt);
    const iv = window.crypto.getRandomValues(new Uint8Array(12));
    const enc = new TextEncoder();
    const encrypted = await window.crypto.subtle.encrypt(
      { name: "AES-GCM", iv: iv },
      derivedKey,
      enc.encode(JSON.stringify(privateKeyJwk))
    );

    return {
      encryptedData: btoa(String.fromCharCode(...new Uint8Array(encrypted))),
      iv: btoa(String.fromCharCode(...iv)),
      salt: btoa(String.fromCharCode(...salt))
    };
  },

  // Decrypt Private Key
  async decryptPrivateKey(encryptedObj, password) {
    const salt = new Uint8Array(atob(encryptedObj.salt).split("").map(c => c.charCodeAt(0)));
    const iv = new Uint8Array(atob(encryptedObj.iv).split("").map(c => c.charCodeAt(0)));
    const data = new Uint8Array(atob(encryptedObj.encryptedData).split("").map(c => c.charCodeAt(0)));
    
    const derivedKey = await this.deriveKeyFromPassword(password, salt);
    const decrypted = await window.crypto.subtle.decrypt(
      { name: "AES-GCM", iv: iv },
      derivedKey,
      data
    );

    const dec = new TextDecoder();
    return JSON.parse(dec.decode(decrypted));
  },

  // Encrypt Letter (AES-GCM + RSA-OAEP)
  async encryptLetter(content, recipientPublicKeyJwk, senderPublicKeyJwk) {
    // 1. Generate random AES key
    const aesKey = await window.crypto.subtle.generateKey(
      { name: "AES-GCM", length: 256 },
      true,
      ["encrypt", "decrypt"]
    );

    // 2. Encrypt content with AES
    const iv = window.crypto.getRandomValues(new Uint8Array(12));
    const enc = new TextEncoder();
    const encryptedContent = await window.crypto.subtle.encrypt(
      { name: "AES-GCM", iv: iv },
      aesKey,
      enc.encode(content)
    );

    // 3. Export AES key to encrypt it with RSA
    const exportedAesKey = await window.crypto.subtle.exportKey("raw", aesKey);

    // 4. Import public keys
    const recipientKey = await this.importPublicKey(recipientPublicKeyJwk);
    const senderKey = await this.importPublicKey(senderPublicKeyJwk);

    // 5. Encrypt AES key for both recipient and sender
    const encryptedAesKeyForRecipient = await window.crypto.subtle.encrypt(
      { name: "RSA-OAEP" },
      recipientKey,
      exportedAesKey
    );
    const encryptedAesKeyForSender = await window.crypto.subtle.encrypt(
      { name: "RSA-OAEP" },
      senderKey,
      exportedAesKey
    );

    return {
      content: btoa(String.fromCharCode(...new Uint8Array(encryptedContent))),
      iv: btoa(String.fromCharCode(...iv)),
      recipientKey: btoa(String.fromCharCode(...new Uint8Array(encryptedAesKeyForRecipient))),
      senderKey: btoa(String.fromCharCode(...new Uint8Array(encryptedAesKeyForSender)))
    };
  },

  // Decrypt Letter
  async decryptLetter(encryptedLetter, privateKey, isSender) {
    const encryptedAesKey = isSender ? encryptedLetter.senderKey : encryptedLetter.recipientKey;
    const encryptedAesKeyData = new Uint8Array(atob(encryptedAesKey).split("").map(c => c.charCodeAt(0)));
    
    // 1. Decrypt AES key with RSA private key
    const aesKeyData = await window.crypto.subtle.decrypt(
      { name: "RSA-OAEP" },
      privateKey,
      encryptedAesKeyData
    );

    // 2. Import decrypted AES key
    const aesKey = await window.crypto.subtle.importKey(
      "raw",
      aesKeyData,
      "AES-GCM",
      true,
      ["decrypt"]
    );

    // 3. Decrypt content
    const iv = new Uint8Array(atob(encryptedLetter.iv).split("").map(c => c.charCodeAt(0)));
    const contentData = new Uint8Array(atob(encryptedLetter.content).split("").map(c => c.charCodeAt(0)));
    
    const decryptedContent = await window.crypto.subtle.decrypt(
      { name: "AES-GCM", iv: iv },
      aesKey,
      contentData
    );

    const dec = new TextDecoder();
    return dec.decode(decryptedContent);
  }
};

window.CryptoUtils = CryptoUtils;
