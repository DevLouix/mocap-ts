import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { join, basename } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Job, JobProgress, JobSource, JobSettings, JobSummary } from './types.js';
import { JobStage, stageMessage, jobLabel } from './types.js';

/**
 * Queue provider interface.
 *
 * A queue provider persists {@link Job} records and lets the API layer
 * (route handlers) and a single background worker cooperate:
 *
 *  - The API calls {@link JobQueue.enqueue} to create a job.
 *  - The worker calls {@link JobQueue.acquireNext} to claim a job, runs the
 *    pipeline, and calls {@link JobQueue.update} with progress as it goes.
 *
 * The default {@link FileJobQueue} implementation is a JSON-on-disk store
 * with atomic writes + a `processing/` sidecar dir for claim/ack semantics.
 * It is designed for a single worker process (the self-hosted case) and can
 * be swapped for Inngest / BullMQ / Redis by implementing this interface.
 *
 * Concurrency model:
 *   acquireNext moves the job file into `processing/`, making it invisible
 *   to other claimants. finish/cancel/fail moves it back into `jobs/` so the
 *   status is queryable. This is the lightweight equivalent of a SQL row
 *   lock; it is safe under a single worker but is not multi-host safe.
 */
export interface JobQueue {
  /** Persist a new job. Returns the full record (with generated id). */
  enqueue(source: JobSource, settings: JobSettings): Job;

  /** Claim the next runnable (queued) job, or `null` if none. */
  acquireNext(): Job | null;

  /** Patch a job's progress/stage. Pushes an event into history. */
  update(id: string, patch: Partial<Pick<Job, 'stage' | 'progress' | 'message' | 'outputName' | 'outputBvhPath' | 'finishedAt'>>): Job;

  /** Mark a job failed. */
  fail(id: string, error: string): Job;

  /** Mark a job cancelled (terminal). */
  cancel(id: string): Job;

  /** Read a single job by id. */
  get(id: string): Job | null;

  /** List all jobs, newest first, as lightweight summaries. */
  list(): JobSummary[];

  /** Remove a job and any artifacts. Implementations may no-op on missing jobs. */
  remove(id: string): void;
}

const HISTORY_CAP = 100;

function nowIso(): string {
  return new Date().toISOString();
}

function pushHistory(job: Job, stage: JobStage, progress: number, message?: string, detail?: string): JobProgress {
  const event: JobProgress = { stage, message: message ?? stageMessage(stage), progress, detail, timestamp: Date.now() };
  job.history.push(event);
  if (job.history.length > HISTORY_CAP) job.history.splice(0, job.history.length - HISTORY_CAP);
  return event;
}

/**
 * File-backed queue. One JSON file per job inside {@link jobsDir}.
 * A `processing/` sibling dir holds in-flight jobs.
 *
 * Writes are atomic (write to temp, rename) so a crash mid-update never
 * leaves a truncated job file.
 */
export class FileJobQueue implements JobQueue {
  private readonly jobsDir: string;
  private readonly processingDir: string;

  constructor(opts: { dataDir: string }) {
    this.jobsDir = opts.dataDir;
    this.processingDir = join(opts.dataDir, 'processing');
    mkdirSync(this.jobsDir, { recursive: true });
    mkdirSync(this.processingDir, { recursive: true });
    // If a previous worker died mid-job, re-queue anything left in processing/.
    this.recoverStuck();
  }

  private recoverStuck(): void {
    for (const f of readdirSync(this.processingDir)) {
      if (!f.endsWith('.json')) continue;
      const from = join(this.processingDir, f);
      const to = join(this.jobsDir, f);
      try {
        const job = this.readJobFile(from);
        job.stage = JobStage.QUEUED;
        job.progress = 0;
        pushHistory(job, JobStage.QUEUED, 0, 'Re-queued after crash');
        this.writeJobFile(to, job);
        rmSync(from, { force: true });
      } catch {
        // Corrupt file — drop it.
        rmSync(from, { force: true });
      }
    }
  }

  enqueue(source: JobSource, settings: JobSettings): Job {
    const id = randomUUID();
    const job: Job = {
      id,
      createdAt: nowIso(),
      source,
      settings,
      stage: JobStage.QUEUED,
      progress: 0,
      message: stageMessage(JobStage.QUEUED),
      history: [],
    };
    pushHistory(job, JobStage.QUEUED, 0);
    this.writeJobFile(this.jobPath(id), job);
    return job;
  }

  acquireNext(): Job | null {
    const queued = readdirSync(this.jobsDir)
      .filter(f => f.endsWith('.json') && !f.startsWith('.'))
      .sort();
    for (const f of queued) {
      const from = join(this.jobsDir, f);
      try {
        const job = this.readJobFile(from);
        if (job.stage !== JobStage.QUEUED) continue;
        renameSync(from, this.processingPath(job.id));
        return job;
      } catch {
        continue;
      }
    }
    return null;
  }

  update(id: string, patch: Partial<Pick<Job, 'stage' | 'progress' | 'message' | 'outputName' | 'outputBvhPath' | 'finishedAt'>>): Job {
    const path = this.findJobPath(id);
    const job = this.readJobFile(path);
    if (patch.stage) job.stage = patch.stage;
    if (patch.progress !== undefined) job.progress = patch.progress;
    if (patch.message !== undefined) job.message = patch.message;
    if (patch.outputName !== undefined) job.outputName = patch.outputName;
    if (patch.outputBvhPath !== undefined) job.outputBvhPath = patch.outputBvhPath;
    if (patch.finishedAt !== undefined) job.finishedAt = patch.finishedAt;
    pushHistory(job, job.stage, job.progress, job.message);
    this.writeJobFile(path, job);
    return job;
  }

  fail(id: string, error: string): Job {
    const path = this.findJobPath(id);
    const job = this.readJobFile(path);
    job.stage = JobStage.FAILED;
    job.error = error;
    job.message = `Failed: ${error}`;
    job.finishedAt = nowIso();
    pushHistory(job, JobStage.FAILED, job.progress, job.message);
    this.writeJobFile(path, job);
    return job;
  }

  cancel(id: string): Job {
    const path = this.findJobPath(id);
    const job = this.readJobFile(path);
    job.stage = JobStage.CANCELLED;
    job.message = stageMessage(JobStage.CANCELLED);
    job.finishedAt = nowIso();
    pushHistory(job, JobStage.CANCELLED, job.progress, job.message);
    this.writeJobFile(path, job);
    return job;
  }

  get(id: string): Job | null {
    try {
      return this.readJobFile(this.findJobPath(id));
    } catch {
      return null;
    }
  }

  list(): JobSummary[] {
    const summaries: JobSummary[] = [];
    for (const f of readdirSync(this.jobsDir)) {
      if (!f.endsWith('.json') || f.startsWith('.')) continue;
      try {
        const job = this.readJobFile(join(this.jobsDir, f));
        summaries.push(this.toSummary(job));
      } catch {
        continue;
      }
    }
    return summaries.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  }

  remove(id: string): void {
    const path = this.findJobPath(id);
    rmSync(path, { force: true });
    rmSync(this.processingPath(id), { force: true });
  }

  // --- helpers ---

  private toSummary(job: Job): JobSummary {
    return {
      id: job.id,
      createdAt: job.createdAt,
      label: jobLabel(job),
      stage: job.stage,
      progress: job.progress,
      outputName: job.outputName,
      error: job.error,
      finishedAt: job.finishedAt,
    };
  }

  private jobPath(id: string): string {
    return join(this.jobsDir, `${id}.json`);
  }

  private processingPath(id: string): string {
    return join(this.processingDir, `${id}.json`);
  }

  /** A job may live in `jobs/` or `processing/`. */
  private findJobPath(id: string): string {
    const safe = `${basename(id.replace(/[^\w-]/g, ''))}.json`;
    const inJobs = join(this.jobsDir, safe);
    if (existsSync(inJobs)) return inJobs;
    const inProcessing = join(this.processingDir, safe);
    if (existsSync(inProcessing)) return inProcessing;
    throw new Error(`Job not found: ${id}`);
  }

  private readJobFile(path: string): Job {
    const raw = readFileSync(path, 'utf-8');
    return JSON.parse(raw) as Job;
  }

  private writeJobFile(path: string, job: Job): void {
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, JSON.stringify(job, null, 2), 'utf-8');
    renameSync(tmp, path);
  }
}

