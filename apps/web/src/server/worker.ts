import 'server-only';
import { getQueue, getJobDirs, setInngestSender, MOCAP_JOB_EVENT, type InngestJobPayload } from '@mocap-ts/core/jobs';
import { initInngestSender } from '@/server/inngest/functions';
import { mkdirSync } from 'node:fs';

/**
 * Worker bootstrap.
 *
 * Two modes, selected by `MOCAP_QUEUE`:
 *
 *   - default (file): start a single in-process worker loop that polls the
 *     on-disk queue and runs the pipeline. Best for self-hosting + dev.
 *   - inngest: register the Inngest event sender so `enqueue` dispatches to
 *     Inngest; the actual pipeline runs inside the Inngest step function
 *     (see functions.ts), so no local worker loop is started.
 *
 * Either way this is called once from `instrumentation.ts` so the TF-native
 * runner is loaded exactly once in the server process and never bundled into
 * per-route code.
 */
let started = false;
let controller: { stopped: boolean } | null = null;

export function ensureWorker(): void {
  if (started) return;
  started = true;

  if (process.env.MOCAP_QUEUE === 'inngest') {
    // Inngest mode: just wire the sender. Execution is Inngest's job.
    initInngestSender();
    return;
  }

  // File mode: start the local polling worker.
  controller = { stopped: false };
  const dirs = getJobDirs();
  mkdirSync(dirs.workDir, { recursive: true });
  mkdirSync(dirs.outDir, { recursive: true });
  const verbose = process.env.MOCAP_VERBOSE === '1';
  // Lazy import the runner to keep this file eval-light when Inngest is on.
  void import('@mocap-ts/core/jobs').then(({ startWorkerLoop }) => {
    void startWorkerLoop(getQueue(), dirs, controller!).catch(err => {
      console.error('[mocap-ts] worker loop crashed:', err);
      started = false;
      controller = null;
    });
  });
  for (const sig of ['SIGINT', 'SIGTERM'] as const) {
    process.once(sig, () => {
      if (controller) controller.stopped = true;
    });
  }
}
