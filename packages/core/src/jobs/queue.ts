import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { join, basename, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Job, JobProgress, JobSource, JobSettings, JobSummary, JobTenantContext } from './types.js';
import { JobStage, stageMessage, jobLabel, isTerminalStage } from './types.js';

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
  enqueue(source: JobSource, settings: JobSettings, tenant?: JobTenantContext): Job;

  /** Claim the next runnable job, or a specific queued job by id. */
  acquireNext(id?: string): Job | null;

  /** Dispatch a persisted job to the external execution provider. */
  dispatch(id: string): void;

  /** Patch a job's progress/stage. Pushes an event into history. */
  update(id: string, patch: Partial<Pick<Job, 'stage' | 'progress' | 'message' | 'outputName' | 'outputBvhPath' | 'finishedAt'>>): Job;

  /**
   * Patch a job's source after enqueue.
   *
   * Used by the upload flow: the job is created first (to get an id), then
   * the file is saved to `<dataDir>/uploads/<id>.<ext>` and the concrete
   * path is written back into the source. The worker reads `source.path`
   * to find the video — an upload with an empty path is a bug.
   */
  patchSource(id: string, patch: Partial<JobSource>): Job;

  /** Mark a job failed. */
  fail(id: string, error: string): Job;

  /** Mark a job cancelled (terminal). */
  cancel(id: string): Job;

  /** Check whether a worker should stop processing the job. */
  isCancellationRequested(id: string): boolean;

  /** Read a single job by id, optionally enforcing workspace ownership. */
  get(id: string, workspaceId?: string): Job | null;

  /** List jobs, optionally limited to a workspace, newest first. */
  list(workspaceId?: string): JobSummary[];

  /** Remove a job and any artifacts. Implementations may no-op on missing jobs. */
  remove(id: string): void;
}

const HISTORY_CAP = 100;

function isPathInside(root: string, candidate: string): boolean {
  const rootPath = resolve(root);
  const candidatePath = resolve(candidate);
  return candidatePath === rootPath || candidatePath.startsWith(`${rootPath}/`);
}

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
        if (job.cancelRequested) {
          job.stage = JobStage.CANCELLED;
          job.message = stageMessage(JobStage.CANCELLED);
          job.finishedAt = job.finishedAt ?? nowIso();
          pushHistory(job, JobStage.CANCELLED, job.progress, job.message);
        } else {
          job.stage = JobStage.QUEUED;
          job.progress = 0;
          job.leasedAt = undefined;
          pushHistory(job, JobStage.QUEUED, 0, 'Re-queued after crash');
        }
        this.writeJobFile(to, job);
        rmSync(from, { force: true });
      } catch {
        // Corrupt file — drop it.
        rmSync(from, { force: true });
      }
    }
  }

  enqueue(source: JobSource, settings: JobSettings, tenant: JobTenantContext = {
    organizationId: 'local-organization',
    workspaceId: 'local-workspace',
    createdBy: 'local-user',
  }): Job {
    const id = randomUUID();
    const job: Job = {
      id,
      createdAt: nowIso(),
      organizationId: tenant.organizationId,
      workspaceId: tenant.workspaceId,
      createdBy: tenant.createdBy,
      attempt: 0,
      maxAttempts: 3,
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

  acquireNext(id?: string): Job | null {
    const queued = readdirSync(this.jobsDir)
      .filter(f => f.endsWith('.json') && !f.startsWith('.') && (!id || f === `${id}.json`))
      .sort();
    for (const f of queued) {
      const from = join(this.jobsDir, f);
      try {
        const job = this.readJobFile(from);
        if (job.stage !== JobStage.QUEUED) continue;
        job.attempt = (job.attempt ?? 0) + 1;
        job.leasedAt = nowIso();
        job.error = undefined;
        this.writeJobFile(from, job);
        renameSync(from, this.processingPath(job.id));
        return job;
      } catch {
        continue;
      }
    }
    return null;
  }

  dispatch(_id: string): void {
    // The file worker polls the persisted queue; no external dispatch is needed.
  }

  update(id: string, patch: Partial<Pick<Job, 'stage' | 'progress' | 'message' | 'outputName' | 'outputBvhPath' | 'finishedAt'>>): Job {
    const path = this.findJobPath(id);
    const job = this.readJobFile(path);
    // A cancellation or terminal completion wins a race with a late worker
    // progress event. This prevents a cancelled job becoming "estimating".
    if (isTerminalStage(job.stage) && patch.stage !== job.stage) return job;
    if (patch.stage) job.stage = patch.stage;
    if (patch.progress !== undefined) job.progress = patch.progress;
    if (patch.message !== undefined) job.message = patch.message;
    if (patch.outputName !== undefined) job.outputName = patch.outputName;
    if (patch.outputBvhPath !== undefined) job.outputBvhPath = patch.outputBvhPath;
    if (patch.finishedAt !== undefined) job.finishedAt = patch.finishedAt;
    if (isTerminalStage(job.stage)) job.leasedAt = undefined;
    pushHistory(job, job.stage, job.progress, job.message);
    if (isTerminalStage(job.stage) && path !== this.jobPath(job.id)) {
      const target = this.jobPath(job.id);
      this.writeJobFile(target, job);
      rmSync(path, { force: true });
    } else {
      this.writeJobFile(path, job);
    }
    return job;
  }

  fail(id: string, error: string): Job {
    const path = this.findJobPath(id);
    const job = this.readJobFile(path);
    if (isTerminalStage(job.stage)) return job;
    // Retry transient worker failures while attempts remain. The job is moved
    // back to the runnable directory so the next poll can claim it.
    if ((job.attempt ?? 0) < (job.maxAttempts ?? 3) && !job.cancelRequested) {
      job.stage = JobStage.QUEUED;
      job.error = `Attempt ${job.attempt} failed: ${error}`;
      job.message = 'Retrying after worker failure';
      job.leasedAt = undefined;
      pushHistory(job, JobStage.QUEUED, job.progress, job.message);
      const target = this.jobPath(job.id);
      this.writeJobFile(target, job);
      if (path !== target) rmSync(path, { force: true });
      return job;
    }
    job.stage = JobStage.FAILED;
    job.error = error;
    job.message = `Failed: ${error}`;
    job.finishedAt = nowIso();
    job.leasedAt = undefined;
    pushHistory(job, JobStage.FAILED, job.progress, job.message);
    if (path !== this.jobPath(job.id)) {
      const target = this.jobPath(job.id);
      this.writeJobFile(target, job);
      rmSync(path, { force: true });
    } else {
      this.writeJobFile(path, job);
    }
    return job;
  }

  patchSource(id: string, patch: Partial<JobSource>): Job {
    const path = this.findJobPath(id);
    const job = this.readJobFile(path);
    // Shallow merge; the union spread isn't directly assignable to the
    // discriminated union, but callers only patch fields of the job's own
    // source kind (today: `path` on uploads).
    job.source = { ...job.source, ...patch } as JobSource;
    this.writeJobFile(path, job);
    return job;
  }

  cancel(id: string): Job {
    const path = this.findJobPath(id);
    const job = this.readJobFile(path);
    if (isTerminalStage(job.stage)) return job;
    job.stage = JobStage.CANCELLED;
    job.cancelRequested = true;
    job.message = stageMessage(JobStage.CANCELLED);
    job.finishedAt = nowIso();
    job.leasedAt = undefined;
    pushHistory(job, JobStage.CANCELLED, job.progress, job.message);
    if (path !== this.jobPath(job.id)) {
      const target = this.jobPath(job.id);
      this.writeJobFile(target, job);
      rmSync(path, { force: true });
    } else {
      this.writeJobFile(path, job);
    }
    return job;
  }

  isCancellationRequested(id: string): boolean {
    const job = this.get(id);
    return job?.cancelRequested === true || job?.stage === JobStage.CANCELLED;
  }

  get(id: string, workspaceId?: string): Job | null {
    try {
      const job = this.readJobFile(this.findJobPath(id));
      return workspaceId && job.workspaceId !== workspaceId ? null : job;
    } catch {
      return null;
    }
  }

  list(workspaceId?: string): JobSummary[] {
    const summaries: JobSummary[] = [];
    for (const f of readdirSync(this.jobsDir)) {
      if (!f.endsWith('.json') || f.startsWith('.')) continue;
      try {
        const job = this.readJobFile(join(this.jobsDir, f));
        if (!workspaceId || job.workspaceId === workspaceId) summaries.push(this.toSummary(job));
      } catch {
        continue;
      }
    }
    return summaries.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  }

  remove(id: string): void {
    let job: Job | null = null;
    try { job = this.readJobFile(this.findJobPath(id)); } catch { /* already absent */ }
    try { rmSync(this.findJobPath(id), { force: true }); } catch { /* already absent */ }
    rmSync(this.processingPath(id), { force: true });
    const dataRoot = join(this.jobsDir, '..');
    for (const candidate of [job?.source.kind === 'upload' ? job.source.path : undefined, job?.outputBvhPath]) {
      if (candidate && isPathInside(dataRoot, candidate)) rmSync(candidate, { force: true });
    }
  }

  // --- helpers ---

  private toSummary(job: Job): JobSummary {
    return {
      id: job.id,
      organizationId: job.organizationId,
      workspaceId: job.workspaceId,
      createdBy: job.createdBy,
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
    const normalizedId = id.trim();
    if (!/^[\w-]{1,128}$/.test(normalizedId)) throw new Error(`Job not found: ${id}`);
    const safe = `${basename(normalizedId)}.json`;
    const inJobs = join(this.jobsDir, safe);
    if (existsSync(inJobs)) return inJobs;
    const inProcessing = join(this.processingDir, safe);
    if (existsSync(inProcessing)) return inProcessing;
    throw new Error(`Job not found: ${id}`);
  }

  private readJobFile(path: string): Job {
    const raw = readFileSync(path, 'utf-8');
    const parsed = JSON.parse(raw) as Partial<Job>;
    // Migrate records created before Phase 0 tenant/retry fields existed.
    return {
      ...parsed,
      organizationId: parsed.organizationId ?? 'local-organization',
      workspaceId: parsed.workspaceId ?? 'local-workspace',
      createdBy: parsed.createdBy ?? 'local-user',
      attempt: parsed.attempt ?? 0,
      maxAttempts: parsed.maxAttempts ?? 3,
      history: parsed.history ?? [],
    } as Job;
  }

  private writeJobFile(path: string, job: Job): void {
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, JSON.stringify(job, null, 2), 'utf-8');
    renameSync(tmp, path);
  }
}

