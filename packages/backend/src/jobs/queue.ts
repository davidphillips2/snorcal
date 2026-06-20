import { Queue, Worker, type Job } from 'bullmq';
import IORedis from 'ioredis';
import { fileURLToPath } from 'node:url';
import { build3MF } from '../services/threemf-builder.js';
import { SlicerExecutor } from '../services/slicer-executor.js';
import { PROJECT_SETTING_OVERRIDES } from '@snorcal/shared';
import { Db } from '../db/index.js';
import type { SliceJobData, MultiMaterialConfig, FilamentSlot } from '@snorcal/shared';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const defaultProjectSettingsRaw = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'routes', 'default-project-settings.json'), 'utf-8'),
);

const QUEUE_NAME = 'slice-jobs';

let queue: Queue | null = null;
let worker: Worker | null = null;

export function getQueue(): Queue {
  if (!queue) throw new Error('Queue not initialized');
  return queue;
}

export function setupQueue(db: Db): { queue: Queue; worker: Worker } | null {
  const redisHost = process.env.REDIS_HOST || 'localhost';
  const redisPort = parseInt(process.env.REDIS_PORT || '6379');

  // Test Redis connection first with a short timeout
  const testConn = new IORedis({
    host: redisHost,
    port: redisPort,
    connectTimeout: 2000,
    retryStrategy: () => null, // No retries for test
  });

  const connectionPromise = testConn.connect().then(() => {
    testConn.disconnect();
    return true;
  }).catch(() => {
    testConn.disconnect();
    return false;
  });

  // We'll set up the queue asynchronously
  connectionPromise.then((available) => {
    if (!available) {
      console.warn('[Queue] Redis not available — slicing jobs will not be processed.');
      console.warn('[Queue] Start Redis or use Docker Compose for full functionality.');
      return;
    }

    const connection = new IORedis({
      host: redisHost,
      port: redisPort,
      maxRetriesPerRequest: null,
    });

    queue = new Queue(QUEUE_NAME, {
      connection,
      defaultJobOptions: {
        removeOnComplete: { count: 200 },
        removeOnFail: { count: 100 },
      },
    });

    worker = new Worker(QUEUE_NAME, async (job: Job<SliceJobData>) => {
      return processSliceJob(job, db);
    }, {
      connection,
      concurrency: 1,
    });

    worker.on('completed', (job) => {
      console.log(`[Worker] Job ${job.id} completed`);
    });

    worker.on('failed', (job, err) => {
      console.error(`[Worker] Job ${job?.id} failed:`, err.message);
      if (job) {
        db.updateJobStatus(job.data.jobId, 'failed', { errorMessage: err.message });
      }
    });

    console.log('[Queue] Connected to Redis — slicing ready');
  });

  // Return null synchronously; queue will be set up asynchronously
  return null;
}

function expandFilamentSlots(
  projectSettings: Record<string, unknown>,
  slots: FilamentSlot[],
  profileSettings: (Record<string, unknown> | null)[],
  db: Db,
  engine: string,
): void {
  const n = slots.length;
  projectSettings['filament_colour'] = slots.map(s => s.color);
  projectSettings['filament_type'] = slots.map(s => s.type);

  // Reload profile settings from DB if not provided
  const resolved = slots.map((slot, i) => {
    if (profileSettings[i]) return profileSettings[i];
    if (!slot.profile) return null;
    const p = db.getProfile(engine, 'filament', slot.profile);
    if (!p) return null;
    try { return JSON.parse(p.settings) as Record<string, unknown>; } catch { return null; }
  });

  // filament_id is scalar metadata (Preset.hpp BBL_JSON_KEY_FILAMENT_ID) — never expand
  const filamentKeys = new Set<string>();
  for (const p of resolved) {
    if (p) for (const key of Object.keys(p)) { if (key.startsWith('filament_') && key !== 'filament_id') filamentKeys.add(key); }
  }

  for (const key of filamentKeys) {
    if (key === 'filament_colour' || key === 'filament_type') continue;
    const existing = projectSettings[key] as any[] | undefined;
    projectSettings[key] = resolved.map((p, i) => {
      if (p && p[key] !== undefined) return String(p[key]);
      return existing?.[i] ?? existing?.[0] ?? '';
    });
  }

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
}

function mergeFilamentProfiles(
  projectSettings: Record<string, unknown>,
  profile0: Record<string, unknown> | null,
  profile1: Record<string, unknown> | null,
  config: MultiMaterialConfig,
): void {
  projectSettings['support_filament'] = config.supportFilament;
  projectSettings['support_interface_filament'] = config.supportInterfaceFilament;

  // filament_id is scalar metadata — never expand
  const filamentKeys = new Set<string>();
  if (profile0) for (const key of Object.keys(profile0)) { if (key.startsWith('filament_') && key !== 'filament_id') filamentKeys.add(key); }
  if (profile1) for (const key of Object.keys(profile1)) { if (key.startsWith('filament_') && key !== 'filament_id') filamentKeys.add(key); }

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
  const f00 = existing?.[0] ?? '0';
  const f01 = existing?.[1] ?? String(defaultFlush);
  const f10 = existing?.[2] ?? String(defaultFlush);
  const f11 = existing?.[3] ?? '0';
  projectSettings['flush_volumes_matrix'] = [f00, f01, f10, f11];
}

async function processSliceJob(job: Job<SliceJobData>, db: Db): Promise<void> {
  const { jobId, modelId, engine, plateIndex, settings, workDir, profiles, multiMaterial, filamentSlots } = job.data;

  db.updateJobStatus(jobId, 'running');
  const executor = new SlicerExecutor();

  try {
    const model = db.getModel(modelId);
    if (!model) throw new Error(`Model ${modelId} not found`);

    await job.updateProgress(5);
    db.updateJobProgress(jobId, 5, 'Building 3MF...');

    const faceColors = model.face_colors
      ? new Uint8Array(model.face_colors)
      : undefined;

    const threemfBuffer = await build3MF({
      stlPath: model.file_path,
      faceColors,
    });

    const input3mfPath = path.join(workDir, 'input.3mf');
    fs.writeFileSync(input3mfPath, threemfBuffer);

    await job.updateProgress(10);
    db.updateJobProgress(jobId, 10, 'Preparing settings...');

    // Build project settings — full template + overrides + user customizations
    const projectSettings: Record<string, unknown> = {
      ...(defaultProjectSettingsRaw as Record<string, unknown>),
      ...PROJECT_SETTING_OVERRIDES,
    };
    if (settings?.process) {
      for (const [key, val] of Object.entries(settings.process)) {
        projectSettings[key] = String(val);
      }
    }
    // Note: profile merge + null-skip happens in runSliceDirect; queue path is
    // currently unused (Redis not deployed in dev) — kept in sync separately.

    // Multi-material: load second filament profile and expand arrays
    if (multiMaterial?.enabled) {
      const profile0Name = profiles?.filament;
      const profile1Name = profiles?.filament2;
      let profile0Settings: Record<string, unknown> | null = null;
      let profile1Settings: Record<string, unknown> | null = null;

      if (profile0Name) {
        const p = db.getProfile(engine, 'filament', profile0Name);
        if (p) try { profile0Settings = JSON.parse(p.settings); } catch {}
      }
      if (profile1Name) {
        const p = db.getProfile(engine, 'filament', profile1Name);
        if (p) try { profile1Settings = JSON.parse(p.settings); } catch {}
      }

      mergeFilamentProfiles(projectSettings, profile0Settings, profile1Settings, multiMaterial);
    }

    // Multi-color filament slots: expand all filament_* arrays to N elements
    if (filamentSlots && filamentSlots.length > 1) {
      expandFilamentSlots(projectSettings, filamentSlots, [], db, engine);
    }

    // Rebuild 3MF with embedded project settings
    const threemfWithSettings = await build3MF({
      stlPath: model.file_path,
      faceColors,
      projectSettings,
    });
    fs.writeFileSync(input3mfPath, threemfWithSettings);

    await job.updateProgress(15);
    db.updateJobProgress(jobId, 15, 'Starting slicer...');

    const outputDir = path.join(workDir, 'output');
    fs.mkdirSync(outputDir, { recursive: true });

    const result = await executor.execute(
      {
        engine,
        input3mf: input3mfPath,
        outputDir,
        processSettings: '',
        machineSettings: '',
        filamentSettings: [],
        plateIndex,
        workDir,
        dataDir: process.env.SLICER_DATADIR || path.join(os.homedir(), 'Library', 'Application Support', 'Snapmaker_Orca'),
      },
      (progress: number, step: string) => {
        const mapped = Math.round(15 + (progress / 100) * 80);
        job.updateProgress(mapped);
        db.updateJobProgress(jobId, mapped, step);
      },
    );

    if (result.exitCode !== 0) {
      throw new Error(
        `Slicer exited with code ${result.exitCode}: ${result.stderr.slice(-500)}`,
      );
    }

    await job.updateProgress(100);
    db.updateJobStatus(jobId, 'completed');
    db.updateJobOutput(jobId, result.gcodeSize);

  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    db.updateJobStatus(jobId, 'failed', { errorMessage: message });
    throw err;
  }
}
