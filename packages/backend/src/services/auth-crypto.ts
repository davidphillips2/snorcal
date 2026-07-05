import crypto from 'node:crypto';
import type { Db } from '../db/index.js';

/**
 * Password hashing + session-token signing, using node `crypto` only.
 *
 * Password format (PHC-ish): `scrypt$N=<cost>$r=<blockSize>$p=<parallel>$<b64 salt>$<b64 key>`
 *
 * Session token format: `<b64url(payload)>.<b64url(hmac)>` where payload = `{ exp: ms }`.
 * HMAC is SHA-256 over the payload b64url string.
 */

const B64 = 'base64';
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

// scrypt parameters — N=32768 (cost), r=8 (block size), p=1 (parallelism).
// Matches OWASP guidance for interactive logins (2024).
const SCRYPT_N = 32768;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEYLEN = 32;
const SCRYPT_MAXMEM = 64 * 1024 * 1024; // 64 MiB — needed for N=32768

export function hashPassword(pw: string): string {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(pw, salt, SCRYPT_KEYLEN, {
    N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P, maxmem: SCRYPT_MAXMEM,
  });
  return `scrypt$N=${SCRYPT_N}$r=${SCRYPT_R}$p=${SCRYPT_P}$${salt.toString(B64)}$${key.toString(B64)}`;
}

export function verifyPassword(pw: string, stored: string): boolean {
  // Tolerate a leading "scrypt$" or a bare hash. Must contain 6 $-segments.
  const parts = stored.split('$');
  // Expected: ['scrypt', 'N=...', 'r=...', 'p=...', '<salt>', '<key>']
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const N = Number(parts[1].split('=')[1]);
  const r = Number(parts[2].split('=')[1]);
  const p = Number(parts[3].split('=')[1]);
  const salt = Buffer.from(parts[4], B64);
  const expected = Buffer.from(parts[5], B64);
  if (!N || !r || !p || !salt.length || !expected.length) return false;
  const key = crypto.scryptSync(pw, salt, expected.length, { N, r, p, maxmem: SCRYPT_MAXMEM });
  // Constant-time compare.
  return crypto.timingSafeEqual(key, expected);
}

// --- Session tokens (HMAC-signed exp claim) ---

export function signToken(secret: string, expMs = SESSION_TTL_MS): string {
  const payload = { exp: Date.now() + expMs };
  const payloadB64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const mac = crypto.createHmac('sha256', secret).update(payloadB64).digest('base64url');
  return `${payloadB64}.${mac}`;
}

export function verifyToken(token: string, secret: string): boolean {
  const parts = token.split('.');
  if (parts.length !== 2) return false;
  const [payloadB64, mac] = parts;
  const expected = crypto.createHmac('sha256', secret).update(payloadB64).digest('base64url');
  // Constant-time compare of the b64url strings.
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  if (!crypto.timingSafeEqual(a, b)) return false;
  try {
    const payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf-8'));
    return typeof payload.exp === 'number' && payload.exp > Date.now();
  } catch {
    return false;
  }
}

// --- Session secret (per-install, persisted) ---

const SESSION_SECRET_KEY = 'auth_session_secret';

/**
 * Session secret precedence: env var → persisted app_settings row → generate + persist.
 * Persisting avoids session invalidation on every restart (the row is generated once).
 */
export function getOrCreateSessionSecret(db: Db): string {
  if (process.env.SNORCAL_SESSION_SECRET) return process.env.SNORCAL_SESSION_SECRET;
  const existing = db.getSetting(SESSION_SECRET_KEY);
  if (existing) return existing;
  const generated = crypto.randomBytes(32).toString('base64url');
  db.setSetting(SESSION_SECRET_KEY, generated);
  return generated;
}

export const SESSION_COOKIE_NAME = 'snorcal_session';
export const AUTH_DISABLED = process.env.SNORCAL_AUTH_DISABLED === '1';
