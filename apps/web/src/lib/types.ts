import type { Job, JobStage, JobSettings, JobProgress } from '@mocap-ts/core/jobs/queue';
import { jobLabel } from '@mocap-ts/core/jobs/queue';

/**
 * The job shape the API returns to the browser.
 *
 * The on-disk {@link Job} carries `outputBvhPath` (an absolute path) and
 * `source.path` — neither should ever reach the client. This projection
 * strips them.
 */
export interface ClientJob {
  id: string;
  createdAt: string;
  source:
    | { kind: 'upload'; filename: string; sizeBytes?: number }
    | { kind: 'url'; url: string };
  settings: JobSettings;
  stage: JobStage;
  progress: number;
  message?: string;
  outputName?: string;
  error?: string;
  finishedAt?: string;
  history: JobProgress[];
  /** Human-friendly label derived from the source. */
  label: string;
}

/** Project a server-side Job into a client-safe ClientJob. */
export function toClientJob(job: Job): ClientJob {
  const source = job.source.kind === 'upload'
    ? { kind: 'upload' as const, filename: job.source.filename, sizeBytes: job.source.sizeBytes }
    : { kind: 'url' as const, url: job.source.url };
  return {
    id: job.id,
    createdAt: job.createdAt,
    source,
    settings: job.settings,
    stage: job.stage,
    progress: job.progress,
    message: job.message,
    outputName: job.outputName,
    error: job.error,
    finishedAt: job.finishedAt,
    history: job.history,
    label: jobLabel(job),
  };
}

