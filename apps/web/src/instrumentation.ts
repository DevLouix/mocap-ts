import { ensureWorker } from '@/server/worker';

/**
 * Next.js instrumentation hook — runs once when the Node server boots.
 *
 * We start the mocap background worker here (not in a route handler) so the
 * TF-native runner is loaded exactly once in the server process and never
 * bundled into per-route code.
 *
 * In a multi-instance deploy, lift the worker into its own `worker.ts`
 * entrypoint so only one process runs the queue.
 */
export async function register(): Promise<void> {
  ensureWorker();
}
