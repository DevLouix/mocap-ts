import 'server-only';
import { NextRequest, NextResponse } from 'next/server';
import { getQueue } from '@/server/jobs';
import { toClientJob } from '@/lib/types';
import { isTerminalStage } from '@mocap-ts/core/jobs/queue';
import { authResponse, requestPrincipal, requireJobWorkspace, requirePermission } from '@/server/auth';
import { getDurablePlatform, isDurableMode } from '@/server/durable';

interface Params {
  params: Promise<{ id: string }>;
}

/** GET /api/jobs/[id] — full job record (client-safe). */
export async function GET(req: NextRequest, { params }: Params) {
  try {
    const principal = requestPrincipal(req.headers, 'job:read');
    const { id } = await params;
    if (isDurableMode()) {
      const job = await getDurablePlatform().getClientJobOrNull(principal, id);
      if (!job) return NextResponse.json({ error: 'Not found' }, { status: 404 });
      return NextResponse.json({ job });
    }
    const job = getQueue().get(id, principal.workspaceId);
    if (!job) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    requireJobWorkspace(principal, job.workspaceId, 'job:read');
    return NextResponse.json({ job: toClientJob(job) });
  } catch (err) {
    return authResponse(err) ?? NextResponse.json({ error: 'Unable to read job' }, { status: 500 });
  }
}

/**
 * DELETE /api/jobs/[id]
 *   - if the job is still running, mark it cancelled (terminal) — the worker
 *     loop drops the current iteration's artifacts on the next tick.
 *   - if the job is terminal, remove it + its BVH from disk entirely.
 */
export async function DELETE(req: NextRequest, { params }: Params) {
  try {
    const principal = requestPrincipal(req.headers);
    const { id } = await params;
    if (isDurableMode()) {
      const platform = getDurablePlatform();
      const job = await platform.getClientJobOrNull(principal, id);
      if (!job) return NextResponse.json({ error: 'Not found' }, { status: 404 });
      const terminal = isTerminalStage(job.stage);
      requirePermission(principal, terminal ? 'job:delete' : 'job:cancel');
      if (terminal) {
        await platform.delete(principal, id);
        return NextResponse.json({ ok: true, removed: true });
      }
      await platform.cancel(principal, id);
      return NextResponse.json({ ok: true, cancelled: true });
    }
    const queue = getQueue();
    const job = queue.get(id, principal.workspaceId);
    if (!job) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    requireJobWorkspace(principal, job.workspaceId, isTerminalStage(job.stage) ? 'job:delete' : 'job:cancel');

    if (isTerminalStage(job.stage)) {
      queue.remove(id);
      return NextResponse.json({ ok: true, removed: true });
    }
    queue.cancel(id);
    return NextResponse.json({ ok: true, cancelled: true });
  } catch (err) {
    return authResponse(err) ?? NextResponse.json({ error: 'Unable to mutate job' }, { status: 500 });
  }
}
