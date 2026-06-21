import type { FastifyInstance } from 'fastify';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { Db } from '../db/index.js';
import { getDataDir } from '../services/model-parser.js';
import { isQueueAvailable } from '../jobs/queue.js';
import { SLICER_BINARIES, getSlicerBinary } from '@snorcal/shared';
import type { SlicerEngine } from '@snorcal/shared';
import { getSidecarUrl } from '../services/slicer-executor.js';

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

async function pingUrl(url: string): Promise<'ok' | 'down'> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);
    await fetch(url, { signal: controller.signal });
    clearTimeout(timeout);
    return 'ok';
  } catch {
    return 'down';
  }
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

    let diskFree: number | null = null;
    let diskTotal: number | null = null;
    try {
      const stat = fs.statfsSync(dataDir);
      diskFree = stat.bsize * stat.bavail;
      diskTotal = stat.bsize * stat.blocks;
    } catch { /* ignore */ }

    const queueState = isQueueAvailable() ? 'connected' : 'fallback';
    const redisHost = process.env.REDIS_HOST || 'localhost';
    const redisPort = parseInt(process.env.REDIS_PORT || '6379');

    // Per-engine sidecar URLs (bambuddy-style separate services per slicer).
    const sidecars: Record<string, { url: string | null; local: boolean }> = {};
    for (const engine of Object.keys(SLICER_BINARIES)) {
      const url = getSidecarUrl(engine);
      sidecars[engine] = { url, local: !url };
    }

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
          sidecars,
          // `local` here is true when ALL engines lack a URL (pure local-binary mode).
          // Useful for legacy callers; new code should consult per-engine `sidecars`.
          local: Object.values(sidecars).every(s => s.local),
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

  // GET /api/system/test-sidecar — ping queue + each configured sidecar URL.
  // Returns per-engine status so the UI can show which sidecars are reachable.
  app.get('/api/system/test-sidecar', async () => {
    const engines = Object.keys(SLICER_BINARIES) as SlicerEngine[];
    const sidecars: Record<string, { url: string | null; status: 'ok' | 'down' | 'unset' }> = {};

    await Promise.all(engines.map(async (engine) => {
      const url = getSidecarUrl(engine);
      if (!url) {
        sidecars[engine] = { url: null, status: 'unset' };
        return;
      }
      sidecars[engine] = { url, status: await pingUrl(url) };
    }));

    return {
      ok: true,
      data: {
        redis: isQueueAvailable() ? 'ok' as const : 'down' as const,
        sidecars,
      },
    };
  });

  // GET /api/system/engines — engines actually usable on this host.
  // An engine is available when EITHER its sidecar URL is configured OR the
  // local binary exists on disk.
  app.get('/api/system/engines', async () => {
    const engines = (Object.keys(SLICER_BINARIES) as SlicerEngine[]).filter(engine => {
      if (getSidecarUrl(engine)) return true;
      try {
        return fs.existsSync(getSlicerBinary(engine).binaryPath);
      } catch {
        return false;
      }
    });
    return { ok: true, data: { engines } };
  });
}
