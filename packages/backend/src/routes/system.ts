import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { Db, DbJob, DbModel } from '../db/index.js';
import { getDataDir } from '../services/model-parser.js';
import { isQueueAvailable } from '../jobs/queue.js';
import { SLICER_BINARIES, getSlicerBinary } from '@snorcal/shared';
import type { SlicerEngine } from '@snorcal/shared';
import { getSidecarUrl } from '../services/slicer-executor.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Repo root for bare-metal (../.. from dist/routes = packages/backend,
// ../../.. = packages, ../../../.. = repo root). For Docker, the root
// package.json is at /app/package.json — walk up looking for a package.json
// named 'snorcal' to find the right one in either layout.
const REPO_ROOT = path.resolve(__dirname, '../../../../');

function readRootPackageVersion(): string {
  // Walk up looking for the snorcal root package.json by name.
  let dir: string = __dirname;
  for (let i = 0; i < 8; i++) {
    const candidate = path.join(dir, 'package.json');
    try {
      const pkg = JSON.parse(fs.readFileSync(candidate, 'utf-8'));
      if (pkg.name === 'snorcal') return (pkg.version as string) || '0.0.0';
    } catch { /* not here */ }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return '0.0.0';
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

  /**
   * Read DB-backed per-engine binary path overrides. Shape: JSON object
   * keyed by SlicerEngine → absolute binary path. Returns `{}` on any parse
   * error or missing key (never throws).
   */
  function readSlicerOverrides(): Record<string, string> {
    try {
      const raw = db.getSetting('slicer_path_overrides');
      if (!raw) return {};
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') {
        const out: Record<string, string> = {};
        for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
          if (typeof v === 'string' && v.trim()) out[k] = v.trim();
        }
        return out;
      }
    } catch { /* malformed JSON in DB — ignore */ }
    return {};
  }

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
    const overrides = readSlicerOverrides();
    const sidecars: Record<string, {
      url: string | null;
      local: boolean;
      binaryExists: boolean;
      overridePath: string | null;
      defaultPath: string;
    }> = {};
    for (const engine of Object.keys(SLICER_BINARIES)) {
      const url = getSidecarUrl(engine);
      const override = overrides[engine];
      let binaryExists = false;
      try { binaryExists = fs.existsSync(getSlicerBinary(engine, override).binaryPath); } catch { /* unknown engine */ }
      // Default path = resolved path WITHOUT override (env-var + platform only).
      // Used by the UI as the input placeholder.
      let defaultPath = '';
      try { defaultPath = getSlicerBinary(engine).binaryPath; } catch { /* unknown engine */ }
      sidecars[engine] = {
        url,
        local: !url,
        binaryExists,
        overridePath: override || null,
        defaultPath,
      };
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
  // local binary exists on disk (honoring DB-backed path overrides).
  app.get('/api/system/engines', async () => {
    const overrides = readSlicerOverrides();
    const engines = (Object.keys(SLICER_BINARIES) as SlicerEngine[]).filter(engine => {
      if (getSidecarUrl(engine)) return true;
      try {
        return fs.existsSync(getSlicerBinary(engine, overrides[engine]).binaryPath);
      } catch {
        return false;
      }
    });
    return { ok: true, data: { engines } };
  });

  // POST /api/system/test-slicer-path — validate a user-entered binary path
  // before saving as override. No DB writes; pure pre-save check.
  // Body: { engine: string, path: string }
  app.post<{ Body: { engine: string; path: string } }>('/api/system/test-slicer-path', async (req, reply) => {
    const { engine, path: binaryPath } = req.body ?? {};
    if (!engine || !(engine in SLICER_BINARIES)) {
      return reply.status(400).send({ ok: false, error: `Unknown engine: ${engine}` });
    }
    if (typeof binaryPath !== 'string' || !binaryPath.trim()) {
      return reply.status(400).send({ ok: false, error: 'path required' });
    }
    const trimmed = binaryPath.trim();
    let exists = false;
    let executable = false;
    let error: string | undefined;
    try {
      exists = fs.existsSync(trimmed);
      if (!exists) {
        error = 'file does not exist';
      } else {
        try {
          fs.accessSync(trimmed, fs.constants.X_OK);
          executable = true;
        } catch {
          error = 'file exists but not executable';
        }
      }
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
    return { ok: true, data: { exists, executable, error } };
  });

  // POST /api/system/cleanup — bulk-purge old jobs + orphaned models.
  // Two-step: caller MUST call with dryRun=true first to preview. When dryRun
  // is false, performs the actual delete (DB rows + on-disk dirs). Refuses to
  // delete running/queued jobs (returns 409).
  //
  // Modes:
  //   completed_jobs    — jobs in status completed/failed/cancelled older than N days
  //   all_jobs          — all jobs older than N days (any status; running/queued refused)
  //   orphaned_models   — models with no jobs in last N days (days=0 = no jobs at all)
  //   all               — jobs + models older than N days (running/queued still refused)
  type CleanupMode = 'completed_jobs' | 'all_jobs' | 'orphaned_models' | 'all';
  app.post<{ Body: { mode: CleanupMode; olderThanDays: number; dryRun: boolean } }>(
    '/api/system/cleanup',
    async (req, reply) => {
      const { mode, olderThanDays, dryRun } = req.body ?? {};
      const validModes: CleanupMode[] = ['completed_jobs', 'all_jobs', 'orphaned_models', 'all'];
      if (!validModes.includes(mode)) {
        return reply.status(400).send({ ok: false, error: `Unknown mode: ${mode}` });
      }
      const days = Math.max(0, Math.floor(Number(olderThanDays) || 0));
      if (typeof dryRun !== 'boolean') {
        return reply.status(400).send({ ok: false, error: 'dryRun (boolean) required' });
      }

      // Gather candidate sets based on mode.
      const jobCandidates: DbJob[] = [];
      const modelCandidates: DbModel[] = [];
      if (mode === 'completed_jobs') {
        jobCandidates.push(...db.listJobsOlderThan(days, ['completed', 'failed', 'cancelled']));
      } else if (mode === 'all_jobs') {
        jobCandidates.push(...db.listJobsOlderThan(days));
      } else if (mode === 'orphaned_models') {
        modelCandidates.push(...db.listOrphanedModels(days));
      } else { // all
        jobCandidates.push(...db.listJobsOlderThan(days));
        modelCandidates.push(...db.listModelsOlderThan(days));
      }

      // Refuse to delete running/queued jobs — would corrupt active slices.
      const active = jobCandidates.filter(j => j.status === 'running' || j.status === 'queued');
      if (active.length > 0) {
        return reply.status(409).send({
          ok: false,
          error: `Refusing to delete ${active.length} running/queued job(s). Wait for completion or cancel first.`,
        });
      }

      // When purging models, their job workDirs must be fs-cleaned too
      // (db.deleteModel cascades the DB rows but not disk files). Pre-compute
      // the full list of job dirs to remove per model so we don't lose them
      // when the model row is deleted.
      const modelJobDirs: string[] = [];
      for (const model of modelCandidates) {
        const jobs = db.listJobsByModel(model.id);
        for (const job of jobs) {
          if (job.output_dir) modelJobDirs.push(path.dirname(job.output_dir));
        }
      }

      // Sum reclaimable bytes (best-effort, never throw).
      let bytesReclaimable = 0;
      for (const job of jobCandidates) {
        if (job.output_dir) {
          try { bytesReclaimable += dirSize(path.dirname(job.output_dir)); } catch { /* missing */ }
        }
      }
      for (const model of modelCandidates) {
        try { bytesReclaimable += dirSize(path.dirname(model.file_path)); } catch { /* missing */ }
      }
      for (const dir of modelJobDirs) {
        try { bytesReclaimable += dirSize(dir); } catch { /* missing */ }
      }

      // Dry run: return counts + samples, no mutation.
      if (dryRun) {
        return {
          ok: true,
          data: {
            mode, olderThanDays: days, dryRun: true,
            jobCount: jobCandidates.length,
            modelCount: modelCandidates.length,
            bytesReclaimable,
            jobIds: jobCandidates.slice(0, 50).map(j => j.id),
            modelIds: modelCandidates.slice(0, 50).map(m => m.id),
          },
        };
      }

      // Execute purge: jobs first (fs + DB row), then models (cascade handles
      // any remaining job DB rows; their workDirs were pre-cleaned above).
      for (const job of jobCandidates) {
        if (job.output_dir) {
          const wd = path.dirname(job.output_dir);
          try { fs.rmSync(wd, { recursive: true, force: true }); } catch { /* ignore */ }
        }
        try { db.deleteJob(job.id); } catch { /* may already be gone */ }
      }
      for (const dir of modelJobDirs) {
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
      }
      for (const model of modelCandidates) {
        try { fs.rmSync(path.dirname(model.file_path), { recursive: true, force: true }); } catch { /* ignore */ }
        try { db.deleteModel(model.id); } catch { /* ignore */ }
      }

      console.log(`[cleanup] mode=${mode} days=${days} purged jobs=${jobCandidates.length} models=${modelCandidates.length} bytes=${bytesReclaimable}`);

      return {
        ok: true,
        data: {
          mode, olderThanDays: days, dryRun: false,
          jobCount: jobCandidates.length,
          modelCount: modelCandidates.length,
          bytesReclaimable,
          jobIds: jobCandidates.slice(0, 50).map(j => j.id),
          modelIds: modelCandidates.slice(0, 50).map(m => m.id),
        },
      };
    },
  );

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
