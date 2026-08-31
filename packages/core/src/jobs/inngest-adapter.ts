import type { JobQueue } from './queue.js';
import { FileJobQueue } from './queue.js';
import type { Job, JobSummary, JobSettings, JobSource } from './types.js';
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

  enqueue(source: JobSource, settings: JobSettings): Job {
    const job = this.file.enqueue(source, settings);
    // Fire the Inngest event so the registered function picks it up.
    // Non-blocking: if Inngest is unreachable, the job stays queued and the
    // local worker loop (if running) will claim it as a fallback.
    void this.sendEvent(job.id, {
      jobId: job.id,
      source,
      settings,
    }).catch(() => {
      // Mark the job as still queued; the file store's acquireNext will
      // eventually claim it locally if a worker is running.
    });
    return job;
  }

  // The remaining methods delegate to the file store so the API surface is
  // identical regardless of provider.
  acquireNext(): Job | null { return this.file.acquireNext(); }
  update(id: string, patch: Partial<Pick<Job, 'stage' | 'progress' | 'message' | 'outputName' | 'outputBvhPath' | 'finishedAt'>>): Job {
    return this.file.update(id, patch);
  }
  fail(id: string, error: string): Job { return this.file.fail(id, error); }
  cancel(id: string): Job { return this.file.cancel(id); }
  get(id: string): Job | null { return this.file.get(id); }
  list(): JobSummary[] { return this.file.list(); }
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
