import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { v4 as uuid } from 'uuid';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Db } from '../db/index.js';
import { getQueue } from '../jobs/queue.js';
import { ensureDir, getJobsDir } from '../services/model-parser.js';
import { build3MF } from '../services/threemf-builder.js';
import { SlicerExecutor } from '../services/slicer-executor.js';
import { PROJECT_SETTING_OVERRIDES } from '@slorca/shared';
import type { SliceRequest, SliceJobData, MultiMaterialConfig, FilamentSlot } from '@slorca/shared';
import os from 'node:os';

// Load the full default project settings template (slicer-exported defaults)
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const defaultProjectSettingsRaw = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'default-project-settings.json'), 'utf-8'),
);

/** Get default slicer datadir for the current platform and engine */
function getDefaultDataDir(engine: string): string {
  const home = os.homedir();
  if (process.platform === 'darwin') {
    const macDirs: Record<string, string> = {
      orcaslicer: 'OrcaSlicer',
      bambustudio: 'BambuStudio',
      snapmaker_orca: 'Snapmaker_Orca',
    };
    return path.join(home, 'Library', 'Application Support', macDirs[engine] ?? 'OrcaSlicer');
  }
  // Linux (Docker)
  const linuxDirs: Record<string, string> = {
    orcaslicer: 'OrcaSlicer',
    bambustudio: 'BambuStudio',
    snapmaker_orca: 'Snapmaker_Orca',
  };
  return path.join(home, '.config', linuxDirs[engine] ?? 'OrcaSlicer');
}

/**
 * Expand all filament_* settings to N-element arrays based on configured slots.
 * Sets filament_colour from slot colors (slicer maps 3MF face colors → filament indices).
 * Builds NxN flush_volumes_matrix.
 */
function expandFilamentSlots(
  projectSettings: Record<string, unknown>,
  slots: FilamentSlot[],
  profileSettings: (Record<string, unknown> | null)[],
): void {
  const n = slots.length;

  // Set filament_colour from slot colors — critical for slicer color→index mapping
  projectSettings['filament_colour'] = slots.map(s => s.color);
  projectSettings['filament_type'] = slots.map(s => s.type);

  // Collect all filament_* keys from all profiles
  const filamentKeys = new Set<string>();
  for (const p of profileSettings) {
    if (p) for (const key of Object.keys(p)) { if (key.startsWith('filament_')) filamentKeys.add(key); }
  }

  // Expand each filament_* key to N-element array
  for (const key of filamentKeys) {
    if (key === 'filament_colour' || key === 'filament_type') continue; // already set
    const existing = projectSettings[key] as any[] | undefined;
    projectSettings[key] = profileSettings.map((p, i) => {
      if (p && p[key] !== undefined) return String(p[key]);
      return existing?.[i] ?? existing?.[0] ?? '';
    });
  }

  // Build NxN flush_volumes_matrix (flattened row-major)
  const defaultFlush = 280;
  const existingMatrix = projectSettings['flush_volumes_matrix'] as string[] | undefined;
  const matrix: string[] = [];
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (r === c) { matrix.push('0'); }
      else {
        const idx = r * n + c;
        matrix.push(existingMatrix && idx < existingMatrix.length ? existingMatrix[idx] : String(defaultFlush));
      }
    }
  }
  projectSettings['flush_volumes_matrix'] = matrix;

  // Enable prime tower and multi-material settings for multi-filament slicing
  if (n > 1) {
    projectSettings['single_extruder_multi_material'] = '1';
    projectSettings['enable_prime_tower'] = '1';
    // Critical: extruder_colour must match filament_colour or slicer ignores multi-extruder
    projectSettings['extruder_colour'] = slots.map(s => s.color);
    projectSettings['default_filament_colour'] = slots.map(s => s.color);
    projectSettings['extruder_offset'] = slots.map(() => '0x0');
    // Wiping volumes NxN (flat row-major, 70ml default)
    const wv: string[] = [];
    for (let r = 0; r < n; r++) {
      for (let c = 0; c < n; c++) {
        wv.push(r === c ? '0' : '70');
      }
    }
    projectSettings['wiping_volumes_extruders'] = wv;
  }
}

/**
 * Legacy 2-slot merge for multi-material support mode.
 */
function mergeFilamentProfiles(
  projectSettings: Record<string, unknown>,
  profile0: Record<string, unknown> | null,
  profile1: Record<string, unknown> | null,
  config: MultiMaterialConfig,
): void {
  projectSettings['support_filament'] = config.supportFilament;
  projectSettings['support_interface_filament'] = config.supportInterfaceFilament;

  const filamentKeys = new Set<string>();
  if (profile0) for (const key of Object.keys(profile0)) { if (key.startsWith('filament_')) filamentKeys.add(key); }
  if (profile1) for (const key of Object.keys(profile1)) { if (key.startsWith('filament_')) filamentKeys.add(key); }

  for (const key of filamentKeys) {
    const val0 = profile0?.[key];
    const val1 = profile1?.[key];
    projectSettings[key] = [
      val0 !== undefined ? String(val0) : (projectSettings[key] as any)?.[0] ?? '',
      val1 !== undefined ? String(val1) : (projectSettings[key] as any)?.[1] ?? '',
    ];
  }

  const defaultFlush = 280;
  const existing = projectSettings['flush_volumes_matrix'] as string[] | undefined;
  projectSettings['flush_volumes_matrix'] = [
    existing?.[0] ?? '0', existing?.[1] ?? String(defaultFlush),
    existing?.[2] ?? String(defaultFlush), existing?.[3] ?? '0',
  ];
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
        multiMaterial: body.multiMaterial,
        filamentSlots: body.filamentSlots,
        workDir,
      };
      await queue.add('slice', jobData, { jobId });
    } else {
      // Direct execution (no Redis) — run in background, return immediately
      runSliceDirect(jobId, body, model.file_path, model.name, workDir, db);
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
        modelName: j.model_name,
        engine: j.engine,
        status: j.status,
        progress: j.progress,
        currentStep: j.current_step,
        gcodeSize: j.gcode_size,
        estimatedTime: j.estimated_time,
        filamentUsedG: j.filament_used_g,
        filamentCost: j.filament_cost,
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
        modelName: job.model_name,
        engine: job.engine,
        status: job.status,
        progress: job.progress,
        currentStep: job.current_step,
        settings: JSON.parse(job.settings),
        gcodeSize: job.gcode_size,
        estimatedTime: job.estimated_time,
        filamentUsedG: job.filament_used_g,
        filamentCost: job.filament_cost,
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
  modelName: string,
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

      // Multi-material: load second filament profile and expand arrays
      if (body.multiMaterial?.enabled) {
        const profile0Name = body.profiles?.filament;
        const profile1Name = body.profiles?.filament2;
        let profile0Settings: Record<string, unknown> | null = null;
        let profile1Settings: Record<string, unknown> | null = null;

        if (profile0Name) {
          const p = db.getProfile(body.engine, 'filament', profile0Name);
          if (p) try { profile0Settings = JSON.parse(p.settings); } catch {}
        }
        if (profile1Name) {
          const p = db.getProfile(body.engine, 'filament', profile1Name);
          if (p) try { profile1Settings = JSON.parse(p.settings); } catch {}
        }

        mergeFilamentProfiles(projectSettings, profile0Settings, profile1Settings, body.multiMaterial);
      }

      // Multi-color filament slots: expand all filament_* arrays to N elements
      if (body.filamentSlots && body.filamentSlots.length > 1) {
        const profileSettings: (Record<string, unknown> | null)[] = body.filamentSlots.map((slot) => {
          if (!slot.profile) return null;
          const p = db.getProfile(body.engine, 'filament', slot.profile);
          if (!p) return null;
          try { return JSON.parse(p.settings) as Record<string, unknown>; } catch { return null; }
        });
        expandFilamentSlots(projectSettings, body.filamentSlots, profileSettings);
      }

      if (body.settings?.process) {
        for (const [key, val] of Object.entries(body.settings.process)) {
          projectSettings[key] = String(val);
        }
      }

      // Resolve per-plate STL and face colors
      let stlPath = modelFilePath;
      let faceColors: Uint8Array | undefined;
      const plateIndex = (body.plateIndex ?? 1);
      const modelRecord = db.getModel(body.modelId);

      console.log(`[slice] model=${body.modelId} plate=${plateIndex} plate_count=${modelRecord?.plate_count} stl=${stlPath}`);

      if (modelRecord && modelRecord.plate_count > 1) {
        const plate = db.getPlate(body.modelId, plateIndex);
        if (plate) {
          stlPath = plate.file_path;
          faceColors = plate.face_colors ? new Uint8Array(plate.face_colors) : undefined;
        }
      } else {
        faceColors = modelRecord?.face_colors ? new Uint8Array(modelRecord.face_colors) : undefined;
      }

      // Debug: log multi-material settings
      console.log(`[slice] filament_colour=${JSON.stringify(projectSettings['filament_colour'])}`);
      console.log(`[slice] filament_type=${JSON.stringify(projectSettings['filament_type'])}`);
      console.log(`[slice] enable_prime_tower=${projectSettings['enable_prime_tower']}`);
      console.log(`[slice] single_extruder_multi_material=${projectSettings['single_extruder_multi_material']}`);
      console.log(`[slice] printer_model=${projectSettings['printer_model']}`);
      console.log(`[slice] faceColors length=${faceColors?.length ?? 0}`);
      console.log(`[slice] filamentSlots=${JSON.stringify(body.filamentSlots)}`);

      const threemfBuffer = await build3MF({
        stlPath,
        faceColors,
        projectSettings,
        rotation: body.rotation,
        positionOffset: body.positionOffset,
        buildVolume: body.buildVolume,
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
          plateIndex: 0,
          workDir,
          dataDir: process.env.SLICER_DATADIR || getDefaultDataDir(body.engine),
        },
        (progress: number, step: string) => {
          const mapped = Math.round(15 + (progress / 100) * 80);
          db.updateJobProgress(jobId, mapped, step);
        },
      );

      if (result.exitCode !== 0) {
        const output = (result.stdout + '\n' + result.stderr).slice(-1000);
        throw new Error(`Slicer exited with code ${result.exitCode}: ${output}`);
      }

      db.updateJobStatus(jobId, 'completed');
      if (result.gcodeSize) db.updateJobOutput(jobId, result.gcodeSize);

      // Rename gcode to use model name
      if (result.gcodePath) {
        const baseName = modelName.replace(/\.[^.]+$/, ''); // strip extension
        const gcodeName = `${baseName}.gcode`;
        const renamedPath = path.join(path.dirname(result.gcodePath), gcodeName);
        try { fs.renameSync(result.gcodePath, renamedPath); } catch { /* keep original name */ }
      }

      // Parse estimates from gcode comments
      if (result.gcodePath && fs.existsSync(result.gcodePath)) {
        const estimates = parseGcodeEstimates(result.gcodePath, modelName);
        db.updateJobEstimates(jobId, estimates);
      } else if (result.gcodePath) {
        // Check renamed path
        const renamed = path.join(path.dirname(result.gcodePath), `${modelName.replace(/\.[^.]+$/, '')}.gcode`);
        if (fs.existsSync(renamed)) {
          const estimates = parseGcodeEstimates(renamed, modelName);
          db.updateJobEstimates(jobId, estimates);
        }
      }
    } catch (err) {
      const message = err instanceof Error ? `${err.message}\n${err.stack?.slice(0, 500)}` : String(err);
      db.updateJobStatus(jobId, 'failed', { errorMessage: message });
    }
  })();
}

function parseGcodeEstimates(gcodePath: string, modelName: string): {
  modelName: string;
  estimatedTime?: string;
  filamentUsedG?: number;
  filamentCost?: number;
} {
  const content = fs.readFileSync(gcodePath, 'utf-8');
  const lines = content.split('\n');

  let estimatedTime: string | undefined;
  let filamentUsedG: number | undefined;
  let filamentCost: number | undefined;

  for (const line of lines) {
    if (!line.startsWith(';')) continue;
    const m1 = line.match(/estimated printing time \(normal mode\) = (.+)/);
    if (m1) estimatedTime = m1[1].trim();
    const m2 = line.match(/total filament used \[g\] = ([\d.]+)/);
    if (m2) filamentUsedG = parseFloat(m2[1]);
    const m3 = line.match(/total filament cost = ([\d.]+)/);
    if (m3) filamentCost = parseFloat(m3[1]);
  }

  return { modelName, estimatedTime, filamentUsedG, filamentCost };
}
