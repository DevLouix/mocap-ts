import type { JobQueue } from './queue.js';
import { FileJobQueue } from './queue.js';
import type { Job, JobSummary, JobSettings, JobSource, JobTenantContext } from './types.js';
import { JobStage } from './types.js';
import { jobLabel, stageMessage } from './types.js';

/**
 * Inngest-backed {@link JobQueue}.
 *
 * Why this shape: Inngest runs the *execution* of a job (durable retries,
 * multi-host), but it doesn't store arbitrary job records or progress for
 * clients to read. So this adapter keeps the on-disk record store from
 * {@link FileJobQueue} (so the API's `get`/`list`/`list` still work) and
 * hands the actual pipeline run to an Inngest step function.
 *
 * Usage:
 *   - Set `MOCAP_QUEUE=inngest` and the Inngest env vars (see the route at
 *     apps/web/src/app/api/inngest/route.ts).
 *   - The worker loop is NOT started locally; Inngest invokes the
 *     registered step function instead.
 *   - Progress is written to the on-disk store from inside the step function
 *     (the SSE events route reads the same store).
 *
 * The adapter is intentionally compatible with the {@link FileJobQueue}
 * surface so the rest of the app is provider-agnostic. Swap providers by
 * changing one env var.
 */
export class InngestJobQueue implements JobQueue {
  private readonly file: FileJobQueue;
  /** Sends an event to Inngest to trigger the job. Set by the host app. */
  readonly sendEvent: (jobId: string, payload: InngestJobPayload) => Promise<void>;

  constructor(opts: {
    dataDir: string;
    sendEvent: (jobId: string, payload: InngestJobPayload) => Promise<void>;
  }) {
    this.file = new FileJobQueue({ dataDir: opts.dataDir });
    this.sendEvent = opts.sendEvent;
  }

  enqueue(source: JobSource, settings: JobSettings, tenant?: JobTenantContext): Job {
    return this.file.enqueue(source, settings, tenant);
  }

  dispatch(id: string): void {
    const job = this.file.get(id);
    if (!job) return;
    // Dispatch only after the API has persisted all source fields, including
    // an uploaded file path. This avoids durable workers claiming incomplete
    // upload jobs.
    void this.sendEvent(job.id, {
      jobId: job.id,
      source: job.source,
      settings: job.settings,
    }).catch(() => {
      // The durable provider will retry delivery; the record remains queued.
    });
  }

  // The remaining methods delegate to the file store so the API surface is
  // identical regardless of provider.
  acquireNext(id?: string): Job | null { return this.file.acquireNext(id); }
  update(id: string, patch: Partial<Pick<Job, 'stage' | 'progress' | 'message' | 'outputName' | 'outputBvhPath' | 'finishedAt'>>): Job {
    return this.file.update(id, patch);
  }
  fail(id: string, error: string): Job { return this.file.fail(id, error); }
  patchSource(id: string, patch: Partial<JobSource>): Job { return this.file.patchSource(id, patch); }
  cancel(id: string): Job { return this.file.cancel(id); }
  isCancellationRequested(id: string): boolean { return this.file.isCancellationRequested(id); }
  get(id: string, workspaceId?: string): Job | null { return this.file.get(id, workspaceId); }
  list(workspaceId?: string): JobSummary[] { return this.file.list(workspaceId); }
  remove(id: string): void { this.file.remove(id); }
}

/** Payload sent to Inngest to trigger a mocap job. */
export interface InngestJobPayload {
  jobId: string;
  source: JobSource;
  settings: JobSettings;
}

/** Inngest event name used to trigger mocap jobs. */
export const MOCAP_JOB_EVENT = 'mocap/job.requested';

// Re-exported for the host app's route handler.
export { jobLabel, stageMessage, JobStage };
