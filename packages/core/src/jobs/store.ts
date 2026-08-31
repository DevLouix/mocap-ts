import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { FileJobQueue } from './queue.js';
import type { JobQueue } from './queue.js';
import { InngestJobQueue } from './inngest-adapter.js';
import type { InngestJobPayload } from './inngest-adapter.js';

/**
 * Process-wide queue singleton, kept in a module that does NOT import the
 * pipeline runner. This way API route handlers can `getQueue()` without
 * pulling @tensorflow/tfjs-node into their Next.js bundle.
 *
 * The worker entrypoint imports the runner separately.
 */

let cached: JobQueue | null = null;

/** A hook the host app sets to dispatch Inngest events. */
let inngestSender: ((jobId: string, payload: InngestJobPayload) => Promise<void>) | null = null;

/** Set by the host app (e.g. apps/web server/worker.ts) to enable Inngest. */
export function setInngestSender(fn: (jobId: string, payload: InngestJobPayload) => Promise<void>): void {
  inngestSender = fn;
}

/** Default data root, overridable via env for tests / container mounts. */
function dataRoot(): string {
  return process.env.MOCAP_DATA_DIR ?? join(process.cwd(), '.mocap');
}

/**
 * Get the process-wide {@link FileJobQueue}.
 *
 * Data layout under `MOCAP_DATA_DIR` (default `.mocap/`):
 *   jobs/        one JSON file per job
 *   jobs/processing/  in-flight jobs (claim/ack sidecar)
 *   uploads/     raw uploaded videos (named by job id)
 *   output/     produced BVH files
 *
 * The directory is created on first use. Safe to call from hot route handlers
 * — it caches a single instance per process.
 */
export function getQueue(): JobQueue {
  if (cached) return cached;
  const root = dataRoot();
  mkdirSync(join(root, 'uploads'), { recursive: true });
  mkdirSync(join(root, 'output'), { recursive: true });
  if (process.env.MOCAP_QUEUE === 'inngest' && inngestSender) {
    cached = new InngestJobQueue({
      dataDir: join(root, 'jobs'),
      sendEvent: inngestSender,
    });
  } else {
    cached = new FileJobQueue({ dataDir: join(root, 'jobs') });
  }
  return cached;
}

/** Absolute paths to the scratch + output dirs, derived from the same root. */
export function getJobDirs(): { workDir: string; outDir: string } {
  const root = dataRoot();
  return {
    workDir: join(root, 'work'),
    outDir: join(root, 'output'),
  };
}

/** Reset the cached queue. Intended for tests. */
export function _resetQueueForTests(): void {
  cached = null;
}
