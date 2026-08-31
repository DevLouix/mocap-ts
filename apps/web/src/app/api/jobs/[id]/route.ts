import 'server-only';
import { NextRequest, NextResponse } from 'next/server';
import { getQueue } from '@/server/jobs';
import { toClientJob } from '@/lib/types';
import { isTerminalStage } from '@mocap-ts/core/jobs/queue';

interface Params {
  params: Promise<{ id: string }>;
}

/** GET /api/jobs/[id] — full job record (client-safe). */
export async function GET(_req: NextRequest, { params }: Params) {
  const { id } = await params;
  const job = getQueue().get(id);
  if (!job) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  return NextResponse.json({ job: toClientJob(job) });
}

/**
 * DELETE /api/jobs/[id]
 *   - if the job is still running, mark it cancelled (terminal) — the worker
 *     loop drops the current iteration's artifacts on the next tick.
 *   - if the job is terminal, remove it + its BVH from disk entirely.
 */
export async function DELETE(_req: NextRequest, { params }: Params) {
  const { id } = await params;
  const queue = getQueue();
  const job = queue.get(id);
  if (!job) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  if (isTerminalStage(job.stage)) {
    queue.remove(id);
    return NextResponse.json({ ok: true, removed: true });
  }
  queue.cancel(id);
  return NextResponse.json({ ok: true, cancelled: true });
}
