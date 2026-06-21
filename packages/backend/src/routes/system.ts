import type { FastifyInstance } from 'fastify';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { Db } from '../db/index.js';
import { getDataDir } from '../services/model-parser.js';
import { isQueueAvailable } from '../jobs/queue.js';

function dirSize(dir: string): number {
  let total = 0;
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) total += dirSize(full);
      else if (entry.isFile()) {
        try { total += fs.statSync(full).size; } catch { /* ignore */ }
      }
    }
  } catch { /* ignore */ }
  return total;
}

export async function systemRoutes(app: FastifyInstance, options: { db: Db }) {
  const { db } = options;

  // GET /api/system/info — app/server config + runtime status (read-only)
  app.get('/api/system/info', async () => {
    const dataDir = getDataDir();
    const dbPath = path.join(dataDir, 'snorcal.db');

    let dbSize: number | null = null;
    try { dbSize = fs.statSync(dbPath).size; } catch { /* not created yet */ }

    const modelsDir = path.join(dataDir, 'models');
    const jobsDir = path.join(dataDir, 'jobs');

    let modelsSize = 0, jobsSize = 0;
    try { modelsSize = dirSize(modelsDir); } catch { /* ignore */ }
    try { jobsSize = dirSize(jobsDir); } catch { /* ignore */ }

    // Disk free space on data volume
    let diskFree: number | null = null;
    let diskTotal: number | null = null;
    try {
      const stat = fs.statfsSync(dataDir);
      diskFree = stat.bsize * stat.bavail;
      diskTotal = stat.bsize * stat.blocks;
    } catch { /* ignore */ }

    // Queue (Redis sidecar) status — null when Redis unavailable (graceful fallback)
    const queueState = isQueueAvailable() ? 'connected' : 'fallback';
    const redisHost = process.env.REDIS_HOST || 'localhost';
    const redisPort = parseInt(process.env.REDIS_PORT || '6379');

    // Slicer sidecar URL — when set, slice jobs are sent to remote HTTP service
    // instead of spawned locally
    const slicerUrl = process.env.SLICER_URL || null;
    const slicerDatadir = process.env.SLICER_DATADIR || null;

    // Data counts
    const modelCount = db.listModels().length;
    const jobCount = db.listJobs().length;
    const printerCount = db.listPrinters().length;

    return {
      ok: true,
      data: {
        storage: {
          dataDir,
          dbSize,
          modelsSize,
          jobsSize,
          diskFree,
          diskTotal,
        },
        counts: {
          models: modelCount,
          jobs: jobCount,
          printers: printerCount,
        },
        queue: {
          state: queueState,
          redisHost,
          redisPort,
        },
        slicer: {
          sidecarUrl: slicerUrl,
          datadir: slicerDatadir,
          local: !slicerUrl,
        },
        host: {
          hostname: os.hostname(),
          platform: process.platform,
          arch: process.arch,
          nodeVersion: process.version,
          uptime: process.uptime(),
        },
      },
    };
  });

  // GET /api/system/test-sidecar — ping queue + (if set) remote slicer URL
  app.get('/api/system/test-sidecar', async () => {
    const results: { redis: 'ok' | 'down'; slicer?: 'ok' | 'down' | 'unset' } = {
      redis: isQueueAvailable() ? 'ok' : 'down',
    };

    const slicerUrl = process.env.SLICER_URL;
    if (slicerUrl) {
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 3000);
        await fetch(slicerUrl, { signal: controller.signal });
        clearTimeout(timeout);
        results.slicer = 'ok';
      } catch {
        results.slicer = 'down';
      }
    } else {
      results.slicer = 'unset';
    }

    return { ok: true, data: results };
  });
}
