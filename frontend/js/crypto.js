/**
 * crypto.js – End-to-end encryption for frag
 *
 * Uses the Web Crypto API (AES-GCM 256-bit) with no external dependencies.
 * Keys are exportable/importable as base64 strings for sharing between devices.
 */

const Crypto = (() => {
  const ALG = { name: 'AES-GCM', length: 256 };
  const IV_LEN = 12; // bytes (96 bits)

  // ── Key management ──────────────────────────────────────────────────────────

  /** Generate a new random AES-GCM 256-bit key. */
  async function generateKey() {
    return crypto.subtle.generateKey(ALG, true /* extractable */, ['encrypt', 'decrypt']);
  }

  /** Export a CryptoKey to a base64 string for storage/sharing. */
  async function exportKey(key) {
    const raw = await crypto.subtle.exportKey('raw', key);
    return bufToBase64(raw);
  }

  /** Import a base64 key string back to a CryptoKey. */
  async function importKey(b64) {
    const raw = base64ToBuf(b64);
    return crypto.subtle.importKey('raw', raw, ALG, true, ['encrypt', 'decrypt']);
  }

  // ── Encrypt / Decrypt ────────────────────────────────────────────────────────

  /**
   * Encrypt a UTF-8 string.
   * Returns a base64 string: [IV (12 bytes) || ciphertext + auth-tag].
   */
  async function encrypt(key, plaintext) {
    const iv = crypto.getRandomValues(new Uint8Array(IV_LEN));
    const encoded = new TextEncoder().encode(plaintext);
    const cipherBuf = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, encoded);
    // Prepend IV
    const combined = new Uint8Array(IV_LEN + cipherBuf.byteLength);
    combined.set(iv, 0);
    combined.set(new Uint8Array(cipherBuf), IV_LEN);
    return bufToBase64(combined.buffer);
  }

  /**
   * Decrypt a base64 string produced by encrypt().
   * Returns the original UTF-8 plaintext, or throws on failure.
   */
  async function decrypt(key, b64) {
    const combined = new Uint8Array(base64ToBuf(b64));
    if (combined.length <= IV_LEN) throw new Error('Ciphertext too short');
    const iv         = combined.slice(0, IV_LEN);
    const ciphertext = combined.slice(IV_LEN);
    const plainBuf = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertext);
    return new TextDecoder().decode(plainBuf);
  }

  // ── Identity ──────────────────────────────────────────────────────────────────

  /**
   * Generate a user identity hash: SHA-256 of 32 random bytes → hex string.
   */
  async function generateIdentityHash() {
    const rand = crypto.getRandomValues(new Uint8Array(32));
    const hashBuf = await crypto.subtle.digest('SHA-256', rand);
    return bufToHex(hashBuf);
  }

  // ── Message fragmentation ─────────────────────────────────────────────────────

  /**
   * Split a base64-encoded encrypted blob into N equal parts.
   * The last part may be slightly longer due to rounding.
   * @param {string} b64 - full encrypted payload (base64)
   * @param {number} n   - number of servers / fragments
   * @returns {string[]} array of N base64 chunk strings
   */
  function splitPayload(b64, n) {
    if (n <= 1) return [b64];
    const chunkSize = Math.ceil(b64.length / n);
    const chunks = [];
    for (let i = 0; i < n; i++) {
      chunks.push(b64.slice(i * chunkSize, (i + 1) * chunkSize));
    }
    return chunks;
  }

  /**
   * Reassemble N fragment payload strings into the original base64 string.
   * Fragments must be passed in order (fragment_index 0..n-1).
   * @param {string[]} chunks - ordered array of payload strings
   * @returns {string} reassembled base64 string
   */
  function joinPayload(chunks) {
    return chunks.join('');
  }

  // ── Utilities ────────────────────────────────────────────────────────────────

  function bufToBase64(buf) {
    const bytes = new Uint8Array(buf instanceof ArrayBuffer ? buf : buf.buffer);
    let bin = '';
    for (const b of bytes) bin += String.fromCharCode(b);
    return btoa(bin);
  }

  function base64ToBuf(b64) {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes.buffer;
  }

  function bufToHex(buf) {
    return Array.from(new Uint8Array(buf))
      .map(b => b.toString(16).padStart(2, '0'))
      .join('');
  }

  return {
    generateKey,
    exportKey,
    importKey,
    encrypt,
    decrypt,
    generateIdentityHash,
    splitPayload,
    joinPayload,
    bufToBase64,
    base64ToBuf,
    bufToHex,
  };
})();

export default Crypto;
