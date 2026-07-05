import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { getDataDir } from './model-parser.js';

/**
 * Encryption-at-rest for secrets stored in SQLite (printer access codes, API
 * keys, the Bambu cloud token).
 *
 * Approach: a single data-encryption key (DEK) lives in `DATA_DIR/.secret-key`
 * (32 random bytes, chmod 600). Secrets are encrypted with AES-256-GCM and
 * stored as `enc:v1:<base64(iv | tag | ciphertext)>`.
 *
 * Migration is transparent: a stored value that does NOT start with `enc:v1:`
 * is treated as legacy plaintext, returned as-is, and re-encrypted the next
 * time it's written. So existing plaintext secrets keep working and gradually
 * migrate without a schema change or a dedicated migration pass.
 *
 * Caveat: the DEK is on the same host as the DB, so this protects against
 * read access to a DB backup/snapshot (or a SQLite file copy) but NOT against
 * a full host compromise. That's the intended threat model for this layer.
 */

const KEY_FILE = path.join(getDataDir(), '.secret-key');
const PREFIX = 'enc:v1:';

let cachedKey: Buffer | null = null;

/** Load (or generate + persist) the 32-byte DEK. Memoized after first call. */
function getKey(): Buffer {
  if (cachedKey) return cachedKey;
  try {
    const raw = fs.readFileSync(KEY_FILE);
    if (raw.length === 32) {
      cachedKey = raw;
      return cachedKey;
    }
    // Wrong length — fall through to generate (shouldn't happen in practice).
  } catch (err: any) {
    if (err.code !== 'ENOENT') throw err; // surfacing unexpected fs errors
  }
  // Generate a fresh key.
  const key = crypto.randomBytes(32);
  // Write with restrictive perms. fs.constants.O_CREAT | O_EXCL avoids a race
  // where two processes start simultaneously; mode 0o600 = owner read/write.
  const fd = fs.openSync(KEY_FILE, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, 0o600);
  try {
    fs.writeSync(fd, key);
  } finally {
    fs.closeSync(fd);
  }
  cachedKey = key;
  return cachedKey;
}

export function encryptSecret(plain: string): string {
  if (plain === '') return '';
  const key = getKey();
  const iv = crypto.randomBytes(12); // GCM standard nonce size
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(plain, 'utf-8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  const blob = Buffer.concat([iv, tag, ct]).toString('base64');
  return PREFIX + blob;
}

export function decryptSecret(stored: string): string {
  if (!stored || !stored.startsWith(PREFIX)) {
    // Legacy plaintext (or empty) — return as-is. Gets re-encrypted on next write.
    return stored;
  }
  const key = getKey();
  const buf = Buffer.from(stored.slice(PREFIX.length), 'base64');
  if (buf.length < 12 + 16) throw new Error('malformed ciphertext');
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const ct = buf.subarray(28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  const plain = Buffer.concat([decipher.update(ct), decipher.final()]);
  return plain.toString('utf-8');
}

/** True if `stored` is already encrypted (starts with the enc:v1: marker). */
export function isEncrypted(stored: string | null | undefined): boolean {
  return !!stored && stored.startsWith(PREFIX);
}
