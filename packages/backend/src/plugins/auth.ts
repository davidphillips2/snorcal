import type { FastifyInstance, FastifyPluginCallback, FastifyReply, FastifyRequest } from 'fastify';
import type { Db } from '../db/index.js';
import {
  AUTH_DISABLED,
  SESSION_COOKIE_NAME,
  getOrCreateSessionSecret,
  hashPassword,
  signToken,
  verifyPassword,
  verifyToken,
} from '../services/auth-crypto.js';

const PASSWORD_HASH_KEY = 'auth_password_hash';

/** Endpoints accessible without an authenticated session. */
const PUBLIC_API_PREFIXES = ['/api/auth/', '/api/health'];

function isPublic(url: string): boolean {
  return PUBLIC_API_PREFIXES.some((p) => url.startsWith(p));
}

function readCookie(req: FastifyRequest, name: string): string | null {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const k = part.slice(0, eq).trim();
    if (k === name) return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return null;
}

function isSecureRequest(req: FastifyRequest): boolean {
  // trustProxy is enabled in app.ts, so req.protocol reflects X-Forwarded-Proto.
  // Treat `https` and the TLS-terminating proxies' upgrades as secure.
  return req.protocol === 'https';
}

/** Build a Set-Cookie value for the session token. No @fastify/cookie dep. */
function sessionCookieValue(token: string, secure: boolean): string {
  const parts = [
    `${SESSION_COOKIE_NAME}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${30 * 24 * 60 * 60}`,
  ];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

function setSessionCookie(reply: FastifyReply, token: string, secure: boolean): void {
  reply.header('Set-Cookie', sessionCookieValue(token, secure));
}

function clearSessionCookie(reply: FastifyReply): void {
  reply.header('Set-Cookie', `${SESSION_COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

export interface AuthState {
  disabled: boolean;
  requiresSetup: boolean;
}

/** Resolve current auth state from env + DB. */
export function getAuthState(db: Db): AuthState {
  if (AUTH_DISABLED) return { disabled: true, requiresSetup: false };
  const requiresSetup = !process.env.SNORCAL_PASSWORD_HASH && !db.getSetting(PASSWORD_HASH_KEY);
  return { disabled: false, requiresSetup };
}

/** Returns true if the request carries a valid session cookie. */
function isAuthenticated(req: FastifyRequest, secret: string): boolean {
  const tok = readCookie(req, SESSION_COOKIE_NAME);
  return !!tok && verifyToken(tok, secret);
}

/**
 * onRequest guard. Skips public endpoints. In setup mode, allows only
 * `/api/auth/*` and `/api/health`. Otherwise requires a valid session cookie.
 */
export function makeAuthGuard(db: Db) {
  const secret = getOrCreateSessionSecret(db);
  return async (req: FastifyRequest, reply: FastifyReply) => {
    if (AUTH_DISABLED) return; // open mode (dev/local-only)
    if (isPublic(req.url)) return;
    const { requiresSetup } = getAuthState(db);
    if (requiresSetup) {
      // Lock everything except the public set until a password is configured.
      return reply
        .status(401)
        .header('WWW-Authenticate', 'Cookie')
        .send({ ok: false, error: 'setup required', requiresSetup: true });
    }
    if (!isAuthenticated(req, secret)) {
      return reply
        .status(401)
        .header('WWW-Authenticate', 'Cookie')
        .send({ ok: false, error: 'unauthorized' });
    }
  };
}

export const authRoutes: FastifyPluginCallback<{ db: Db }> = (app, opts, done) => {
  const db = opts.db;

  // GET /api/auth/status — drives the AuthGate UI state.
  app.get('/api/auth/status', async (req) => {
    const { disabled, requiresSetup } = getAuthState(db);
    if (disabled) return { ok: true, data: { disabled: true, requiresSetup: false, authenticated: true } };
    if (requiresSetup) return { ok: true, data: { disabled: false, requiresSetup: true, authenticated: false } };
    const secret = getOrCreateSessionSecret(db);
    const token = readCookie(req, SESSION_COOKIE_NAME);
    const authenticated = !!token && verifyToken(token, secret);
    return { ok: true, data: { disabled: false, requiresSetup: false, authenticated } };
  });

  // POST /api/auth/login — { password } → sets session cookie.
  app.post('/api/auth/login', async (req, reply) => {
    const { password } = (req.body ?? {}) as { password?: string };
    if (typeof password !== 'string' || !password) {
      return reply.status(400).send({ ok: false, error: 'Password required' });
    }
    const { requiresSetup } = getAuthState(db);
    if (requiresSetup) {
      return reply.status(409).send({ ok: false, error: 'Setup required', requiresSetup: true });
    }
    const stored = process.env.SNORCAL_PASSWORD_HASH ?? db.getSetting(PASSWORD_HASH_KEY);
    if (!stored || !verifyPassword(password, stored)) {
      return reply.status(401).send({ ok: false, error: 'Invalid password' });
    }
    const secret = getOrCreateSessionSecret(db);
    const token = signToken(secret);
    setSessionCookie(reply, token, isSecureRequest(req));
    return { ok: true, data: { authenticated: true } };
  });

  // POST /api/auth/logout — clears the session cookie.
  app.post('/api/auth/logout', async (_req, reply) => {
    clearSessionCookie(reply);
    return { ok: true };
  });

  // POST /api/auth/setup — first-run password set. Only works when no
  // password is configured yet (env var set takes this off the table too).
  app.post('/api/auth/setup', async (req, reply) => {
    const { password } = (req.body ?? {}) as { password?: string };
    if (typeof password !== 'string' || password.length < 6) {
      return reply.status(400).send({ ok: false, error: 'Password must be at least 6 characters' });
    }
    const { requiresSetup } = getAuthState(db);
    if (!requiresSetup) {
      return reply.status(409).send({ ok: false, error: 'A password is already configured' });
    }
    db.setSetting(PASSWORD_HASH_KEY, hashPassword(password));
    const secret = getOrCreateSessionSecret(db);
    const token = signToken(secret);
    setSessionCookie(reply, token, isSecureRequest(req));
    return { ok: true, data: { authenticated: true } };
  });

  done();
};
