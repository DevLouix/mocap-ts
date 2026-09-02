import 'server-only';

/**
 * Worker bootstrap — Node.js runtime only (see instrumentation.ts).
 *
 * Two modes, selected by `MOCAP_PERSISTENCE` and `MOCAP_QUEUE`:
 *
 *   - default (file): start a single in-process worker loop that polls the
 *     on-disk queue and runs the pipeline. Best for self-hosting + dev.
 *   - durable: a separate @mocap-ts/worker service consumes BullMQ jobs.
 *   - inngest: register the Inngest event sender so `enqueue` dispatches to
 *     Inngest; the actual pipeline runs inside the Inngest step function
 *     (see functions.ts), so no local worker loop is started.
 *
 * Everything node- or TF-touching (node:fs, the queue/runner barrel with
 * @tensorflow/tfjs-node + node:child_process) is imported dynamically so
 * this module can be *bundled* for the edge-runtime instrumentation compile
 * without pulling any of it into that graph.
 */
let started = false;
let controller: { stopped: boolean } | null = null;

export function ensureWorker(): void {
  if (started) return;
  started = true;

  if (process.env.MOCAP_PERSISTENCE === 'durable') {
    // Durable mode has a dedicated worker service. Never boot the legacy
    // file worker inside a horizontally-scalable web process.
    return;
  }

  if (process.env.MOCAP_QUEUE === 'inngest') {
    // Inngest mode: just wire the sender. Execution is Inngest's job.
    void import('@/server/inngest/functions').then(({ initInngestSender }) => initInngestSender());
    return;
  }

  // File mode: start the local polling worker.
  controller = { stopped: false };
  void Promise.all([
    import('node:fs'),
    import('node:child_process'),
    import('@mocap-ts/core/jobs'),
  ])
    .then(([{ mkdirSync }, { execFile }, { getQueue, getJobDirs, startWorkerLoop }]) => {
      const dirs = getJobDirs();
      mkdirSync(dirs.workDir, { recursive: true });
      mkdirSync(dirs.outDir, { recursive: true });

      // Fail fast (with a boot-time warning, not a dead job mid-pipeline)
      // when the external binaries the pipeline shells out to are missing.
      for (const bin of ['ffmpeg', 'ffprobe', 'yt-dlp'] as const) {
        execFile('which', [bin], (err) => {
          if (err) {
            const hint =
              bin === 'yt-dlp'
                ? 'URL jobs will fail until it is installed (pip install yt-dlp).'
                : 'All jobs will fail until it is installed (apt/brew install ffmpeg).';
            console.warn(`[mocap-ts] WARNING: "${bin}" not found on PATH. ${hint}`);
          }
        });
      }

      return startWorkerLoop(getQueue(), dirs, controller!);
    })
    .catch(err => {
      console.error('[mocap-ts] worker loop crashed:', err);
      started = false;
      controller = null;
    });
  for (const sig of ['SIGINT', 'SIGTERM'] as const) {
    process.once(sig, () => {
      if (controller) controller.stopped = true;
    });
  }
}
