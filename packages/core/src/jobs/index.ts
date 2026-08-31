/**
 * Public API for the mocap job system.
 *
 * This barrel includes the runner, which imports @tensorflow/tfjs-node via
 * the pose estimator. Import it ONLY from the worker entrypoint. API route
 * handlers that must stay TF-free import the `jobs/queue` subpath instead.
 *
 *   // worker
 *   import { getQueue, startWorkerLoop, runJob } from '@mocap-ts/core/jobs';
 *
 *   // API route (TF-free)
 *   import { getQueue } from '@mocap-ts/core/jobs/queue';
 */
export * from './types.js';
export * from './queue.js';
export * from './store.js';
export * from './inngest-adapter.js';
export * from './runner.js';
