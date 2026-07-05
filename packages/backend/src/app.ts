import Fastify from 'fastify';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Db } from './db/index.js';
import { modelRoutes } from './routes/models.js';
import { sliceRoutes } from './routes/slice.js';
import { settingsRoutes } from './routes/settings.js';
import { fileRoutes } from './routes/files.js';
import { eventRoutes } from './routes/events.js';
import { printerRoutes } from './routes/printers.js';
import { inventoryRoutes } from './routes/inventory.js';
import { makerworldRoutes } from './routes/makerworld.js';
import { systemRoutes } from './routes/system.js';
import { setupQueue } from './jobs/queue.js';
import { printerManager } from './services/printer-manager.js';
import { ensureDir, getDataDir } from './services/model-parser.js';
import { authRoutes, makeAuthGuard, getAuthState } from './plugins/auth.js';

export async function buildApp() {
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  // bodyLimit covers JSON payloads (face-color PUT can reach several MB on
  // high-poly models). Multipart has its own 500MB limit below.
  // trustProxy: respect X-Forwarded-Proto so secure cookies work behind
  // `tailscale serve`, nginx, or any TLS-terminating reverse proxy.
  const app = Fastify({ logger: true, bodyLimit: 50 * 1024 * 1024, trustProxy: true });

  // Ensure data directories exist
  const dataDir = getDataDir();
  ensureDir(path.join(dataDir, 'models'));
  ensureDir(path.join(dataDir, 'jobs'));
  ensureDir(path.join(dataDir, 'output'));

  // Database
  const dbPath = path.join(dataDir, 'snorcal.db');
  // Migrate legacy filename slorca.db → snorcal.db (one-shot)
  const legacyDbPath = path.join(dataDir, 'slorca.db');
  if (!fs.existsSync(dbPath) && fs.existsSync(legacyDbPath)) {
    fs.renameSync(legacyDbPath, dbPath);
  }
  const db = new Db(dbPath);

  // Auth state boot log — make open/setup modes loudly visible so a misconfigured
  // deploy doesn't silently run with no auth.
  const authState = getAuthState(db);
  if (authState.disabled) {
    app.log.warn('AUTH DISABLED (SNORCAL_AUTH_DISABLED=1). Running open — do not expose to untrusted networks.');
  } else if (authState.requiresSetup) {
    app.log.warn('AUTH: setup required — first run must configure a password via /api/auth/setup.');
  } else {
    app.log.info('AUTH: password configured.');
  }

  // Plugins
  // CORS: frontend is same-origin in prod (this server serves the bundle) and
  // in dev (Vite proxies /api). `origin: false` declines to send any
  // Access-Control-Allow-Origin, blocking credentialed cross-site requests
  // and cross-site WebSocket hijacking. credentials:true so the SameSite=lax
  // auth cookie is honored on same-origin top-level navigations.
  await app.register(cors, { origin: false, credentials: true });
  await app.register(multipart, {
    limits: { fileSize: 500 * 1024 * 1024 },
    attachFieldsToBody: false,
  });

  // Auth guard — runs before every route handler. Public endpoints
  // (/api/auth/*, /api/health) are skipped. Registered after cors/multipart
  // but before route plugins so it sees all /api requests.
  app.addHook('onRequest', makeAuthGuard(db));

  // Job queue (graceful when Redis unavailable — queue connects async)
  setupQueue(db);

  // Auto-connect persisted printers
  printerManager.init(db);

  // Routes
  app.register(authRoutes, { db });
  app.register(modelRoutes, { db });
  app.register(sliceRoutes, { db });
  app.register(settingsRoutes, { db });
  app.register(fileRoutes, { db });
  app.register(eventRoutes);
  app.register(printerRoutes, { db });
  app.register(inventoryRoutes, { db });
  app.register(makerworldRoutes, { db });
  app.register(systemRoutes, { db });

  // Health check
  app.get('/api/health', async () => ({ ok: true, timestamp: new Date().toISOString() }));

  // Serve frontend static files in production
  if (process.env.NODE_ENV === 'production') {
    const frontendDir = process.env.FRONTEND_DIR || path.join(__dirname, '../../frontend/dist');
    const { default: fastifyStatic } = await import('@fastify/static');
    await app.register(fastifyStatic, {
      root: frontendDir,
      prefix: '/',
      wildcard: false,
    });

    // SPA fallback: serve index.html for non-API routes
    app.setNotFoundHandler(async (req, reply) => {
      if (!req.url.startsWith('/api')) {
        return reply.sendFile('index.html');
      }
      return reply.status(404).send({ ok: false, error: 'Not found' });
    });
  }

  return { app, db };
}
