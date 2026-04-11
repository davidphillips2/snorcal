import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { v4 as uuid } from 'uuid';
import path from 'node:path';
import fs from 'node:fs';
import type { Db } from '../db/index.js';
import { getQueue } from '../jobs/queue.js';
import { ensureDir, getJobsDir } from '../services/model-parser.js';
import { build3MF } from '../services/threemf-builder.js';
import { SlicerExecutor } from '../services/slicer-executor.js';
import { PROJECT_SETTING_OVERRIDES } from '@slorca/shared';
import type { SliceRequest, SliceJobData } from '@slorca/shared';
import os from 'node:os';

// Load the full default project settings template (slicer-exported defaults)
import defaultProjectSettingsRaw from './default-project-settings.json';

/** Get default slicer datadir for the current platform */
function getDefaultDataDir(): string {
  const home = os.homedir();
  if (process.platform === 'darwin') {
    // Snapmaker Orca on macOS
    return path.join(home, 'Library', 'Application Support', 'Snapmaker_Orca');
  }
  // Linux (Docker) - OrcaSlicer
  return path.join(home, '.config', 'OrcaSlicer');
}

export async function sliceRoutes(app: FastifyInstance, options: { db: Db }) {
  const { db } = options;

  // POST /api/slice — Submit a slice job
  app.post('/api/slice', async (req: FastifyRequest, reply: FastifyReply) => {
    const body = req.body as SliceRequest;

    if (!body.modelId || !body.engine || !body.settings) {
      return reply.status(400).send({ ok: false, error: 'modelId, engine, and settings are required' });
    }

    const model = db.getModel(body.modelId);
    if (!model) {
      return reply.status(404).send({ ok: false, error: 'Model not found' });
    }

    const validEngines = ['orcaslicer', 'bambustudio', 'snapmaker_orca'];
    if (!validEngines.includes(body.engine)) {
      return reply.status(400).send({ ok: false, error: `Invalid engine: ${body.engine}` });
    }

    const jobId = uuid();
    const workDir = path.join(getJobsDir(), jobId);
    ensureDir(workDir);

    db.insertJob({
      id: jobId,
      modelId: body.modelId,
      engine: body.engine,
      settings: JSON.stringify(body.settings),
      outputDir: path.join(workDir, 'output'),
    });

    // Try BullMQ queue first, fall back to direct execution
    let useQueue = false;
    try {
      getQueue();
      useQueue = true;
    } catch {
      // Queue unavailable — run directly
    }

    if (useQueue) {
      const queue = getQueue();
      const jobData: SliceJobData = {
        jobId,
        modelId: body.modelId,
        engine: body.engine,
        plateIndex: body.plateIndex ?? 0,
        settings: body.settings,
        profiles: body.profiles,
        workDir,
      };
      await queue.add('slice', jobData, { jobId });
    } else {
      // Direct execution (no Redis) — run in background, return immediately
      runSliceDirect(jobId, body, model.file_path, workDir, db);
    }

    return reply.send({ ok: true, data: { jobId } });
  });

  // GET /api/jobs — List jobs
  app.get('/api/jobs', async (req) => {
    const { status } = req.query as { status?: string };
    const jobs = db.listJobs(status);
    return {
      ok: true,
      data: jobs.map((j) => ({
        id: j.id,
        modelId: j.model_id,
        engine: j.engine,
        status: j.status,
        progress: j.progress,
        currentStep: j.current_step,
        createdAt: j.created_at,
      })),
    };
  });

  // GET /api/jobs/:id — Get job detail
  app.get<{ Params: { id: string } }>('/api/jobs/:id', async (req, reply) => {
    const job = db.getJob(req.params.id);
    if (!job) {
      return reply.status(404).send({ ok: false, error: 'Job not found' });
    }

    return {
      ok: true,
      data: {
        id: job.id,
        modelId: job.model_id,
        engine: job.engine,
        status: job.status,
        progress: job.progress,
        currentStep: job.current_step,
        settings: JSON.parse(job.settings),
        gcodeSize: job.gcode_size,
        errorMessage: job.error_message,
        createdAt: job.created_at,
        startedAt: job.started_at,
        completedAt: job.completed_at,
      },
    };
  });

  // POST /api/jobs/:id/cancel — Cancel a job
  app.post<{ Params: { id: string } }>('/api/jobs/:id/cancel', async (req, reply) => {
    const job = db.getJob(req.params.id);
    if (!job) {
      return reply.status(404).send({ ok: false, error: 'Job not found' });
    }

    if (job.status !== 'running' && job.status !== 'queued') {
      return reply.status(400).send({ ok: false, error: `Cannot cancel job in status: ${job.status}` });
    }

    try {
      const queue = getQueue();
      const bullJob = await queue.getJob(req.params.id);
      if (bullJob) await bullJob.discard();
    } catch {
      // Queue not available
    }

    db.updateJobStatus(req.params.id, 'cancelled');
    return { ok: true };
  });

  // DELETE /api/jobs/:id — Delete a job
  app.delete<{ Params: { id: string } }>('/api/jobs/:id', async (req, reply) => {
    const job = db.getJob(req.params.id);
    if (!job) {
      return reply.status(404).send({ ok: false, error: 'Job not found' });
    }

    if (job.output_dir) {
      const workDir = path.dirname(job.output_dir);
      if (fs.existsSync(workDir)) {
        fs.rmSync(workDir, { recursive: true, force: true });
      }
    }

    return { ok: true };
  });
}

/**
 * Run slicing directly without Redis/BullMQ.
 * Executes async — the HTTP response returns immediately with the jobId.
 * Client polls GET /api/jobs/:id for progress.
 */
function runSliceDirect(
  jobId: string,
  body: SliceRequest,
  modelFilePath: string,
  workDir: string,
  db: Db,
) {
  // Fire and forget — errors are captured in the DB
  (async () => {
    const executor = new SlicerExecutor();
    try {
      db.updateJobStatus(jobId, 'running');
      db.updateJobProgress(jobId, 5, 'Building 3MF...');

      // Build project settings — full template + U1/SnapSpeed overrides + profile overlays + user customizations
      const projectSettings: Record<string, unknown> = {
        ...(defaultProjectSettingsRaw as Record<string, unknown>),
        ...PROJECT_SETTING_OVERRIDES,
      };

      // Merge selected profiles (machine → filament → process)
      if (body.profiles) {
        const engine = body.engine;
        for (const type of ['machine', 'filament', 'process'] as const) {
          const profileName = body.profiles[type];
          if (!profileName) continue;
          const profile = db.getProfile(engine, type, profileName);
          if (!profile) continue;
          try {
            const profileSettings = JSON.parse(profile.settings) as Record<string, unknown>;
            for (const [key, val] of Object.entries(profileSettings)) {
              // Skip metadata fields that aren't actual slicer settings
              if (['type', 'name', 'inherits', 'from', 'version'].includes(key)) continue;
              projectSettings[key] = val;
            }
          } catch {
            // Skip unparseable profile
          }
        }
      }

      if (body.settings?.process) {
        for (const [key, val] of Object.entries(body.settings.process)) {
          projectSettings[key] = String(val);
        }
      }

      const faceColors = (db.getModel(body.modelId))?.face_colors;
      const threemfBuffer = await build3MF({
        stlPath: modelFilePath,
        faceColors: faceColors ? new Uint8Array(faceColors) : undefined,
        projectSettings,
      });

      const input3mfPath = path.join(workDir, 'input.3mf');
      fs.writeFileSync(input3mfPath, threemfBuffer);

      const outputDir = path.join(workDir, 'output');
      fs.mkdirSync(outputDir, { recursive: true });

      db.updateJobProgress(jobId, 15, 'Starting slicer...');
      const result = await executor.execute(
        {
          engine: body.engine,
          input3mf: input3mfPath,
          outputDir,
          processSettings: '',
          machineSettings: '',
          filamentSettings: [],
          plateIndex: body.plateIndex ?? 0,
          workDir,
          dataDir: process.env.SLICER_DATADIR || getDefaultDataDir(),
        },
        (progress: number, step: string) => {
          const mapped = Math.round(15 + (progress / 100) * 80);
          db.updateJobProgress(jobId, mapped, step);
        },
      );

      if (result.exitCode !== 0) {
        throw new Error(`Slicer exited with code ${result.exitCode}: ${result.stderr.slice(-500)}`);
      }

      db.updateJobStatus(jobId, 'completed');
      if (result.gcodeSize) db.updateJobOutput(jobId, result.gcodeSize);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      db.updateJobStatus(jobId, 'failed', { errorMessage: message });
    }
  })();
}
