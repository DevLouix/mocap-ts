import { EventEmitter } from 'node:events';
import { Queue, Worker, type JobsOptions, type Processor, type WorkerOptions } from 'bullmq';
import { Redis, type RedisOptions } from 'ioredis';

export const MOTION_QUEUE_NAME = 'mocap-motion-processing';

export interface MotionJobPayload {
  jobId: string;
  organizationId: string;
  workspaceId: string;
  source: Record<string, unknown>;
  settings: Record<string, unknown>;
  cancelRequested?: boolean;
}

export interface QueueOptions {
  redisUrl?: string;
  queueName?: string;
  defaultJobOptions?: JobsOptions;
}

export interface MotionProgressEvent {
  jobId: string;
  stage: string;
  progress: number;
  message?: string;
  timestamp: number;
}

export interface MotionQueue {
  readonly queue: Queue<MotionJobPayload>;
  enqueue(payload: MotionJobPayload, options?: JobsOptions): Promise<string>;
  cancel(jobId: string): Promise<void>;
  close(): Promise<void>;
}

/**
 * BullMQ adapter. Redis is the execution coordination layer; PostgreSQL and
 * object storage remain the sources of truth for metadata and artifacts.
 */
export class BullMotionQueue implements MotionQueue {
  readonly queue: Queue<MotionJobPayload>;
  private readonly connection: Redis;

  constructor(options: QueueOptions = {}) {
    this.connection = redisConnection(options.redisUrl);
    this.queue = new Queue<MotionJobPayload>(options.queueName ?? MOTION_QUEUE_NAME, {
      connection: this.connection,
      defaultJobOptions: options.defaultJobOptions ?? {
        attempts: 3,
        backoff: { type: 'exponential', delay: 5_000 },
        removeOnComplete: { age: 86_400, count: 1000 },
        removeOnFail: { age: 604_800, count: 5000 },
      },
    });
  }

  async enqueue(payload: MotionJobPayload, options?: JobsOptions): Promise<string> {
    const job = await this.queue.add(payload.jobId, payload, {
      jobId: payload.jobId,
      ...options,
    });
    return job.id!;
  }

  async cancel(jobId: string): Promise<void> {
    const job = await this.queue.getJob(jobId);
    if (!job) return;
    await job.updateData({ ...job.data, cancelRequested: true });
    await job.remove().catch(() => undefined);
  }

  async close(): Promise<void> {
    await this.queue.close();
    await this.connection.quit();
  }
}

export interface MotionWorkerOptions {
  redisUrl?: string;
  queueName?: string;
  concurrency?: number;
  processor: Processor<MotionJobPayload>;
}

/** Create an isolated worker; the host controls how the motion engine runs. */
export function createMotionWorker(options: MotionWorkerOptions): Worker<MotionJobPayload> {
  const connection = redisConnection(options.redisUrl);
  const workerOptions: WorkerOptions = {
    connection,
    concurrency: Math.min(Math.max(options.concurrency ?? 1, 1), 32),
    autorun: true,
  };
  return new Worker<MotionJobPayload>(
    options.queueName ?? MOTION_QUEUE_NAME,
    options.processor,
    workerOptions,
  );
}

/** A small in-process event bridge for API/SSE/webhook adapters. */
export class MotionQueueEvents extends EventEmitter {
  emitProgress(event: MotionProgressEvent): void {
    this.emit('progress', event);
  }

  onProgress(listener: (event: MotionProgressEvent) => void): this {
    this.on('progress', listener);
    return this;
  }
}

function redisConnection(redisUrl?: string): Redis {
  const url = redisUrl ?? process.env.REDIS_URL ?? 'redis://127.0.0.1:6379';
  const parsed = new URL(url);
  const options: RedisOptions = {
    host: parsed.hostname,
    port: parsed.port ? Number(parsed.port) : 6379,
    username: parsed.username || undefined,
    password: parsed.password || undefined,
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
  };
  if (parsed.protocol === 'rediss:') options.tls = {};
  return new Redis(options);
}
