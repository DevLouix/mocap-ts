import 'server-only';
import { inngest } from './client';
import { getQueue, getJobDirs, setInngestSender, MOCAP_JOB_EVENT, type InngestJobPayload, runJob } from '@mocap-ts/core/jobs';
import type { Job } from '@mocap-ts/core/jobs/queue';
import { mkdirSync } from 'node:fs';

/**
 * Wire up the Inngest event sender so the queue's `enqueue` dispatches to
 * Inngest. Called once at server boot (from instrumentation). Idempotent.
 */
export function initInngestSender(): void {
  setInngestSender(async (jobId, payload) => {
    await inngest.send({ name: MOCAP_JOB_EVENT, data: { ...payload, jobId } });
  });
}

/**
 * The mocap step function.
 *
 * Inngest invokes this when a `mocap/job.requested` event fires. It claims
 * the job record, runs the streaming pipeline (which writes progress to the
 * on-disk store the SSE route reads), and finalizes it.
 *
 * Retries are handled by Inngest: if this throws, Inngest re-invokes with
 * exponential backoff up to the configured limit.
 */
export const runMocapJob = inngest.createFunction(
  { id: 'run-mocap-job', name: 'Run mocap pipeline', retries: 2 },
  { event: MOCAP_JOB_EVENT },
  async ({ event, step }) => {
    const payload = event.data as InngestJobPayload;
    const queue = getQueue();
    const job = queue.get(payload.jobId);
    if (!job) {
      return { status: 'not_found', jobId: payload.jobId };
    }

    const dirs = getJobDirs();
    mkdirSync(dirs.workDir, { recursive: true });
    mkdirSync(dirs.outDir, { recursive: true });
    const verbose = process.env.MOCAP_VERBOSE === '1';

    // Claim the job (moves it into processing/ so a local worker won't
    // double-claim it). If the job isn't in QUEUED state, skip — Inngest
    // retries may have already started it.
    const claimed = queue.acquireNext();
    if (!claimed || claimed.id !== job.id) {
      // Either nothing to claim, or Inngest raced with a local worker.
      return { status: 'already_running_or_done', jobId: job.id };
    }

    // Run the pipeline as a single Inngest step so retries replay the whole
    // job. (Per-stage step boundaries can be added later for finer retry.)
    await step.run('run-pipeline', async () => {
      await runJob(queue, claimed as Job, { ...dirs, verbose });
      return { ok: true };
    });

    return { status: 'done', jobId: job.id };
  },
);
