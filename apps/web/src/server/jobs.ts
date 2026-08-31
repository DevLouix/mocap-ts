import 'server-only';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { getQueue as coreGetQueue, getJobDirs as coreGetJobDirs } from '@mocap-ts/core/jobs/queue';
import type { JobQueue } from '@mocap-ts/core/jobs/queue';

/**
 * Server-side access to the mocap job queue — TF-free.
 *
 * `server-only` guarantees these helpers never leak into a client bundle.
 * The worker bootstrap (which DOES import TF) lives in `server/worker.ts`
 * and is only loaded from `instrumentation.ts`.
 */

export type { JobQueue };

export function getQueue(): JobQueue {
  return coreGetQueue();
}

export function getJobDirs() {
  return coreGetJobDirs();
}

/** Absolute path where an uploaded video should be saved for a given job id. */
export function uploadPath(jobId: string, filename: string): string {
  const root = process.env.MOCAP_DATA_DIR ?? join(process.cwd(), '.mocap');
  const dir = join(root, 'uploads');
  mkdirSync(dir, { recursive: true });
  const ext = filename.slice(filename.lastIndexOf('.'));
  return join(dir, `${jobId}${ext || '.mp4'}`);
}
