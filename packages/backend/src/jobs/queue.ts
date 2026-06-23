import { Queue, Worker, type Job } from 'bullmq';
import IORedis from 'ioredis';
import { Db } from '../db/index.js';
import type { SliceJobData, SliceRequest } from '@snorcal/shared';
import { runSliceJob } from '../routes/slice.js';

const QUEUE_NAME = 'slice-jobs';

let queue: Queue | null = null;
let worker: Worker | null = null;

export function getQueue(): Queue {
  if (!queue) throw new Error('Queue not initialized');
  return queue;
}

/** True when Redis-backed queue is connected; false when running in fallback mode. */
export function isQueueAvailable(): boolean {
  return queue !== null;
}

export function setupQueue(db: Db): { queue: Queue; worker: Worker } | null {
  const redisHost = process.env.REDIS_HOST || 'localhost';
  const redisPort = parseInt(process.env.REDIS_PORT || '6379');

  // Test Redis connection first with a short timeout. ioredis auto-connects
  // on instantiation, so `.connect()` would throw "already connecting".
  const testConn = new IORedis({
    host: redisHost,
    port: redisPort,
    connectTimeout: 2000,
    retryStrategy: () => null, // No retries for test
    lazyConnect: true, // Don't auto-connect; we want to control the attempt
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
      connection: connection as any,
      defaultJobOptions: {
        removeOnComplete: { count: 200 },
        removeOnFail: { count: 100 },
      },
    });

    worker = new Worker(QUEUE_NAME, async (job: Job<SliceJobData>) => {
      return processSliceJob(job, db);
    }, {
      connection: connection as any,
      concurrency: 1,
    });

    worker.on('completed', (job) => {
      console.log(`[Worker] Job ${job.id} completed`);
    });

    worker.on('failed', (job, err) => {
      console.error(`[Worker] Job ${job?.id} failed:`, err.message);
      console.error(err.stack);
      if (job) {
        db.updateJobStatus(job.data.jobId, 'failed', { errorMessage: err.message });
      }
    });

    console.log('[Queue] Connected to Redis — slicing ready');
  });

  // Return null synchronously; queue will be set up asynchronously
  return null;
}

/**
 * Reconstruct SliceRequest from SliceJobData and delegate to runSliceJob —
 * the same code path used when Redis is unavailable. Single source of truth
 * for settings merge, face-color resolution, multi-material expansion, etc.
 */
async function processSliceJob(job: Job<SliceJobData>, db: Db): Promise<void> {
  const { jobId, modelId, engine, plateIndex, settings, workDir, profiles, multiMaterial, filamentSlots } = job.data;

  const model = db.getModel(modelId);
  if (!model) throw new Error(`Model ${modelId} not found`);

  const sliceReq: SliceRequest = {
    modelId,
    engine,
    plateIndex,
    settings,
    profiles,
    multiMaterial,
    filamentSlots,
  };

  await runSliceJob(jobId, sliceReq, model.file_path, model.name, workDir, db, (progress) => {
    job.updateProgress(progress).catch(() => {});
  });
}
