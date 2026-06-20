import Fastify from 'fastify';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import path from 'node:path';
import fs from 'node:fs';
import { Db } from './db/index.js';
import { modelRoutes } from './routes/models.js';
import { sliceRoutes } from './routes/slice.js';
import { settingsRoutes } from './routes/settings.js';
import { fileRoutes } from './routes/files.js';
import { eventRoutes } from './routes/events.js';
import { printerRoutes } from './routes/printers.js';
import { inventoryRoutes } from './routes/inventory.js';
import { setupQueue } from './jobs/queue.js';
import { printerManager } from './services/printer-manager.js';
import { ensureDir, getDataDir } from './services/model-parser.js';

export async function buildApp() {
  const app = Fastify({ logger: true });

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

  // Plugins
  await app.register(cors, { origin: true });
  await app.register(multipart, {
    limits: { fileSize: 500 * 1024 * 1024 },
    attachFieldsToBody: false,
  });

  // Job queue (graceful when Redis unavailable — queue connects async)
  setupQueue(db);

  // Auto-connect persisted printers
  printerManager.init(db);

  // Routes
  app.register(modelRoutes, { db });
  app.register(sliceRoutes, { db });
  app.register(settingsRoutes, { db });
  app.register(fileRoutes, { db });
  app.register(eventRoutes);
  app.register(printerRoutes, { db });
  app.register(inventoryRoutes, { db });

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
