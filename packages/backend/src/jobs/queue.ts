import { Queue, Worker, type Job } from 'bullmq';
import IORedis from 'ioredis';
import { fileURLToPath } from 'node:url';
import { build3MF } from '../services/threemf-builder.js';
import { SlicerExecutor } from '../services/slicer-executor.js';
import { PROJECT_SETTING_OVERRIDES } from '@slorca/shared';
import { Db } from '../db/index.js';
import type { SliceJobData } from '@slorca/shared';
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

async function processSliceJob(job: Job<SliceJobData>, db: Db): Promise<void> {
  const { jobId, modelId, engine, plateIndex, settings, workDir } = job.data;

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
