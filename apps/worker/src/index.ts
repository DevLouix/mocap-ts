import { mkdirSync, rmSync } from 'node:fs';
import { join, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { createDatabase, WorkerJobRepository, type TenantContext } from '@mocap-ts/db';
import { validateRemoteVideoUrl } from '@mocap-ts/core/video/url-policy';
import { createObjectStorage } from '@mocap-ts/storage';
import { BullMotionQueue, createMotionWorker, type MotionJobPayload } from '@mocap-ts/queue';
import { runPipelineStreaming } from '@mocap-ts/core/jobs';
import type { JobSettings } from '@mocap-ts/core/jobs';

const database = createDatabase();
const jobs = new WorkerJobRepository(database.pool);
const storage = createObjectStorage();
const workRoot = process.env.MOCAP_WORK_DIR ?? join(tmpdir(), 'mocap-worker');
const LEASE_SECONDS = Math.min(Math.max(Number(process.env.MOCAP_LEASE_SECONDS ?? 300), 30), 86_400);
const REAPER_MS = Math.min(Math.max(Number(process.env.MOCAP_REAPER_INTERVAL_MS ?? 30_000), 5_000), 300_000);

const worker = createMotionWorker({
  redisUrl: process.env.REDIS_URL,
  queueName: process.env.MOCAP_QUEUE_NAME,
  concurrency: Number(process.env.MOCAP_WORKER_CONCURRENCY ?? 1),
  processor: async bullJob => processJob(bullJob.data, value => bullJob.updateProgress(value)),
});

let recoveryTimer: ReturnType<typeof setInterval> | null = null;
let recoveryRunning = false;

worker.on('completed', job => console.info(JSON.stringify({ event: 'job.completed', jobId: job.data.jobId })));
worker.on('failed', (job, error) => console.error(JSON.stringify({ event: 'job.failed', jobId: job?.data.jobId, error: error.message })));
worker.on('error', error => console.error(JSON.stringify({ event: 'worker.error', error: error.message })));

async function processJob(payload: MotionJobPayload, reportProgress: (value: number) => Promise<void>): Promise<void> {
  await database.migrate();
  await storage.ensureBucket();
  const claimed = await jobs.claim(payload.jobId, LEASE_SECONDS);
  if (!claimed) return;

  let leaseLost = false;
  const heartbeatTimer = setInterval(() => {
    void jobs.heartbeat({
      organizationId: claimed.organizationId,
      workspaceId: claimed.workspaceId,
      principalId: claimed.createdBy,
    }, claimed.id, claimed.leaseToken, LEASE_SECONDS).then(alive => {
      if (!alive) leaseLost = true;
    }).catch(() => {
      // A transient database error is tolerated; the next heartbeat or
      // progress update will determine whether this attempt is still fenced.
    });
  }, Math.max(5_000, Math.floor(LEASE_SECONDS * 1000 / 3)));
  heartbeatTimer.unref?.();
  const assertLease = () => {
    if (leaseLost) throw new Error('Worker lease was lost; stopping stale attempt');
  };

  const context: TenantContext = {
    organizationId: claimed.organizationId,
    workspaceId: claimed.workspaceId,
    principalId: claimed.createdBy,
  };
  const jobDir = join(workRoot, claimed.id);
  const sourcePath = join(jobDir, `source-${randomUUID()}.bin`);
  const outputDir = join(jobDir, 'output');
  mkdirSync(outputDir, { recursive: true });

  try {
    const source = claimed.source;
    let inputPath = sourcePath;
    if (source.kind === 'upload' && typeof source.objectKey === 'string') {
      await storage.downloadToFile(
        { bucket: storage.bucket, key: source.objectKey },
        sourcePath,
      );
    } else if (source.kind === 'url' && typeof source.url === 'string') {
      await validateRemoteVideoUrl(source.url);
      const { downloadVideo } = await import('@mocap-ts/core/video/decoder');
      inputPath = downloadVideo(source.url, { outDir: jobDir, verbose: process.env.MOCAP_VERBOSE === '1' }).videoPath;
    } else {
      throw new Error('Durable worker received an invalid source');
    }

    const settings = claimed.settings as unknown as JobSettings;
    const result = await runPipelineStreaming(
      inputPath,
      outputDir,
      settings,
      (stage, progress, detail) => {
        assertLease();
        void jobs.update(context, claimed.id, { stage, progress }, claimed.leaseToken).then(updated => {
          if (!updated) leaseLost = true;
        }).catch(() => {
          // The next heartbeat/progress callback will stop the attempt if the
          // database fence is no longer valid.
        });
        void reportProgress(progress);
      },
      process.env.MOCAP_VERBOSE === '1',
    );

    const outputName = basename(result.bvhPath);
    const outputKey = `organizations/${claimed.organizationId}/workspaces/${claimed.workspaceId}/jobs/${claimed.id}/outputs/${outputName}`;
    await storage.put(
      { bucket: storage.bucket, key: outputKey },
      await import('node:fs/promises').then(fs => fs.readFile(result.bvhPath)),
      outputName.endsWith('.fbx') ? 'application/octet-stream' : 'text/plain; charset=utf-8',
    );
    assertLease();
    const finished = await jobs.finish(context, claimed.id, outputKey, claimed.leaseToken);
    if (!finished) throw new Error('Job was cancelled or lease was lost before completion');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const outcome = await jobs.fail(context, claimed.id, message, claimed.leaseToken);
    if (outcome === 'cancelled' || outcome === 'stale') return;
    throw error;
  } finally {
    clearInterval(heartbeatTimer);
    rmSync(jobDir, { recursive: true, force: true });
  }
}

async function shutdown(signal: string): Promise<void> {
  console.info(JSON.stringify({ event: 'worker.shutdown', signal }));
  if (recoveryTimer) clearInterval(recoveryTimer);
  await worker.close();
  await recoveryQueue.close();
  await database.close();
  process.exit(0);
}

process.once('SIGINT', () => void shutdown('SIGINT'));
process.once('SIGTERM', () => void shutdown('SIGTERM'));

async function recoverExpiredJobs(): Promise<void> {
  if (recoveryRunning) return;
  recoveryRunning = true;
  try {
    await database.migrate();
    const recovered = await jobs.recoverExpired(100);
    for (const job of recovered) {
      if (job.stage !== 'queued' || job.cancelRequested) continue;
      await publishQueuedJob(job);
      console.info(JSON.stringify({ event: 'job.requeued', jobId: job.id, attempt: job.attempt }));
    }

    // Reconcile rows that may have been committed before Redis became
    // unavailable. BullMQ de-duplicates the stable job id while a message is
    // present, so this is safe to run on every reaper tick.
    const queued = await jobs.listQueued(100);
    for (const job of queued) await publishQueuedJob(job);
  } catch (error) {
    console.error(JSON.stringify({ event: 'worker.reaper.error', error: error instanceof Error ? error.message : String(error) }));
  } finally {
    recoveryRunning = false;
  }
}

async function publishQueuedJob(job: {
  id: string;
  organizationId: string;
  workspaceId: string;
  source: Record<string, unknown>;
  settings: Record<string, unknown>;
  attempt?: number;
}): Promise<void> {
  try {
    const queueMessageId = job.attempt && job.attempt > 0
      ? `${job.id}:attempt:${job.attempt}`
      : job.id;
    await recoveryQueue.enqueue({
      jobId: job.id,
      organizationId: job.organizationId,
      workspaceId: job.workspaceId,
      source: job.source,
      settings: job.settings,
    }, { jobId: queueMessageId });
  } catch (error) {
    await jobs.recordDispatchFailure(
      { organizationId: job.organizationId, workspaceId: job.workspaceId, principalId: job.organizationId },
      job.id,
      error instanceof Error ? error.message : String(error),
    ).catch(() => undefined);
    throw error;
  }
}

// Worker does not expose queue.add(), so the reaper uses a producer adapter
// alongside the consumer Worker instance.
const recoveryQueue = new BullMotionQueue({
  redisUrl: process.env.REDIS_URL,
  queueName: process.env.MOCAP_QUEUE_NAME,
});
recoveryTimer = setInterval(() => void recoverExpiredJobs(), REAPER_MS);
recoveryTimer.unref?.();
void recoverExpiredJobs();

console.info(JSON.stringify({
  event: 'worker.started',
  queue: process.env.MOCAP_QUEUE_NAME ?? 'mocap-motion-processing',
  concurrency: Number(process.env.MOCAP_WORKER_CONCURRENCY ?? 1),
  leaseSeconds: LEASE_SECONDS,
  reaperIntervalMs: REAPER_MS,
}));
