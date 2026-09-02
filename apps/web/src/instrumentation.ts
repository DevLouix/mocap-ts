/**
 * Next.js instrumentation hook — runs once when the server boots.
 *
 * The mocap worker (and the TF-native pipeline it pulls in) can only run in
 * the Node.js runtime, so it's imported conditionally per the documented
 * pattern: https://nextjs.org/docs/app/building-your-application/optimizing/instrumentation
 *
 * The dynamic import keeps node:fs / node:child_process /
 * @tensorflow/tfjs-node out of the edge-runtime compile of this file.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { ensureWorker } = await import('@/server/worker');
    ensureWorker();
  }
}
