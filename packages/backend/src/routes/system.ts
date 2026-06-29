import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { Db } from '../db/index.js';
import { getDataDir } from '../services/model-parser.js';
import { isQueueAvailable } from '../jobs/queue.js';
import { SLICER_BINARIES, getSlicerBinary } from '@snorcal/shared';
import type { SlicerEngine } from '@snorcal/shared';
import { getSidecarUrl } from '../services/slicer-executor.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Repo root = three levels up from dist/routes/system.js
// (dist/routes/system.js -> dist/routes -> dist -> packages/backend -> repo root is ../../.. from packages/backend)
// Dist layout: packages/backend/dist/routes/system.js → repo root = ../../../../
const REPO_ROOT = path.resolve(__dirname, '../../../../');

function readRootPackageVersion(): string {
  try {
    const pkgPath = path.join(REPO_ROOT, 'package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
    return (pkg.version as string) || '0.0.0';
  } catch {
    return '0.0.0';
  }
}

const APP_VERSION = readRootPackageVersion();
const GITHUB_REPO = 'davidphillips2/snorcal';

function gitDescribe(): { sha: string | null; branch: string | null; dirty: boolean | null } {
  try {
    const sha = spawnSync('git', ['-C', REPO_ROOT, 'rev-parse', '--short=8', 'HEAD'], { encoding: 'utf-8' });
    const branch = spawnSync('git', ['-C', REPO_ROOT, 'rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf-8' });
    const status = spawnSync('git', ['-C', REPO_ROOT, 'status', '--porcelain'], { encoding: 'utf-8' });
    return {
      sha: sha.status === 0 ? sha.stdout.trim() : null,
      branch: branch.status === 0 ? branch.stdout.trim() : null,
      dirty: status.status === 0 ? status.stdout.trim().length > 0 : null,
    };
  } catch {
    return { sha: null, branch: null, dirty: null };
  }
}

function isDocker(): boolean {
  try {
    if (fs.existsSync('/.dockerenv')) return true;
    if (process.platform === 'linux' && fs.existsSync('/proc/1/cgroup')) {
      const c = fs.readFileSync('/proc/1/cgroup', 'utf-8');
      if (/docker|containerd|kubepods/.test(c)) return true;
    }
  } catch { /* ignore */ }
  return false;
}

function isBareMetalRepo(): boolean {
  return fs.existsSync(path.join(REPO_ROOT, '.git'));
}

/**
 * Compare two semver-ish strings (leading "v" stripped). Returns -1 / 0 / 1.
 * Handles tags like "v0.1.28", "0.1.28", "v0.1.28-1-gabc".
 */
function cmpVersion(a: string, b: string): number {
  const norm = (v: string) => v.replace(/^v/, '').split('-')[0].split('.').map(n => parseInt(n, 10) || 0);
  const [aa, ab] = [norm(a), norm(b)];
  for (let i = 0; i < Math.max(aa.length, ab.length); i++) {
    const d = (aa[i] ?? 0) - (ab[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

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
        version: APP_VERSION,
        git: gitDescribe(),
        installMode: isDocker() ? 'docker' : (isBareMetalRepo() ? 'bare-metal' : 'unknown'),
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

  // GET /api/system/check-update — fetch latest tag from GitHub, compare to current version.
  app.get('/api/system/check-update', async (_req: FastifyRequest, reply: FastifyReply) => {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 8000);
      const res = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/tags`, {
        headers: { 'Accept': 'application/vnd.github+json', 'User-Agent': 'snorcal' },
        signal: controller.signal,
      });
      clearTimeout(timeout);
      if (!res.ok) {
        return reply.status(502).send({ ok: false, error: `GitHub API ${res.status}` });
      }
      const tags = (await res.json()) as Array<{ name: string }>;
      if (!Array.isArray(tags) || tags.length === 0) {
        return { ok: true, data: { current: APP_VERSION, latest: null, hasUpdate: false } };
      }
      // Tags come most-recent-first by GitHub default. Find highest semver though
      // (in case a non-semver tag like "nightly" was pushed).
      const semverTags = tags
        .map(t => t.name)
        .filter(name => /^v?\d+\.\d+\.\d+/.test(name));
      semverTags.sort((a, b) => cmpVersion(b, a));
      const latest = semverTags[0] ?? null;
      const hasUpdate = latest ? cmpVersion(latest, APP_VERSION) > 0 : false;
      return { ok: true, data: { current: APP_VERSION, latest, hasUpdate } };
    } catch (err) {
      return reply.status(502).send({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });

  // POST /api/system/update — git fetch + reset to latest tag, pnpm install + build.
  // Bare-metal only. Docker must update via container pull.
  app.post('/api/system/update', async (req: FastifyRequest, reply: FastifyReply) => {
    if (isDocker()) {
      return reply.status(400).send({
        ok: false,
        error: 'Running in Docker — update the container image instead (docker pull + restart).',
      });
    }
    if (!isBareMetalRepo()) {
      return reply.status(400).send({
        ok: false,
        error: `No .git directory at ${REPO_ROOT} — cannot self-update. Clone the repo or re-run install.sh.`,
      });
    }

    const git = gitDescribe();
    if (git.dirty) {
      return reply.status(409).send({
        ok: false,
        error: 'Working tree has uncommitted changes. Commit, stash, or revert them before updating.',
        git,
      });
    }

    const run = (cmd: string, args: string[]): { code: number; stdout: string; stderr: string } => {
      const r = spawnSync(cmd, args, { cwd: REPO_ROOT, encoding: 'utf-8', timeout: 120_000 });
      return { code: r.status ?? -1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
    };

    type Step = { name: string; result: { code: number; stdout: string; stderr: string } };
    const steps: Step[] = [];

    // 1. fetch
    steps.push({ name: 'git fetch', result: run('git', ['fetch', '--tags', '--quiet', 'origin']) });
    if (steps[steps.length - 1].result.code !== 0) {
      return reply.status(500).send({ ok: false, error: 'git fetch failed', steps });
    }

    // 2. resolve latest tag
    const latestTagResult = run('git', ['tag', '--sort=-v:refname']);
    if (latestTagResult.code !== 0) {
      return reply.status(500).send({ ok: false, error: 'git tag list failed', steps });
    }
    const latestTag = latestTagResult.stdout.split('\n').map(s => s.trim()).filter(Boolean)[0];
    if (!latestTag) {
      return reply.status(500).send({ ok: false, error: 'No git tags found in repo', steps });
    }

    // 3. reset hard to tag
    steps.push({ name: `git reset --hard ${latestTag}`, result: run('git', ['reset', '--hard', latestTag]) });
    if (steps[steps.length - 1].result.code !== 0) {
      return reply.status(500).send({ ok: false, error: `git reset to ${latestTag} failed`, steps });
    }

    // 4. pnpm install
    steps.push({ name: 'pnpm install', result: run('pnpm', ['install', '--frozen-lockfile']) });
    if (steps[steps.length - 1].result.code !== 0) {
      return reply.status(500).send({ ok: false, error: 'pnpm install failed', steps });
    }

    // 5. pnpm build
    steps.push({ name: 'pnpm build', result: run('pnpm', ['build']) });
    if (steps[steps.length - 1].result.code !== 0) {
      return reply.status(500).send({ ok: false, error: 'pnpm build failed', steps });
    }

    return {
      ok: true,
      data: {
        previousVersion: APP_VERSION,
        newVersion: latestTag.replace(/^v/, ''),
        steps: steps.map(s => ({ name: s.name, code: s.result.code, stderrTail: s.result.stderr.slice(-500) })),
        requiresRestart: true,
      },
    };
  });

  // POST /api/system/restart — self-restart the service by killing current pid.
  // Spawns a detached killer so the response can be sent before death.
  // Service manager (launchd / systemd --user / Scheduled Task) auto-restarts.
  app.post('/api/system/restart', async (_req: FastifyRequest, reply: FastifyReply) => {
    const pid = process.pid;
    const killArgs = process.platform === 'win32'
      ? ['-c', `timeout /t 1 /nobreak >nul & taskkill /PID ${pid} /F`]
      : ['-c', `sleep 1; kill -TERM ${pid}; sleep 5; kill -KILL ${pid} 2>/dev/null || true`];

    try {
      const killer = spawn(process.platform === 'win32' ? 'cmd.exe' : 'sh', killArgs, {
        detached: true,
        stdio: 'ignore',
      });
      killer.unref();
    } catch (err) {
      return reply.status(500).send({
        ok: false,
        error: `Failed to spawn restart killer: ${err instanceof Error ? err.message : String(err)}`,
      });
    }

    return { ok: true, data: { pid, message: 'Restarting — service manager will bring backend back up.' } };
  });
}
