import 'server-only';
import { NextRequest, NextResponse } from 'next/server';
import { getQueue } from '@/server/jobs';
import { toClientJob } from '@/lib/types';
import { isTerminalStage } from '@mocap-ts/core/jobs/queue';
import { authResponse, requestPrincipal } from '@/server/auth';
import { getDurablePlatform, isDurableMode } from '@/server/durable';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

interface Params {
  params: Promise<{ id: string }>;
}

const POLL_MS = 800;
const MAX_LIFETIME_MS = 60 * 60 * 1000; // 1h safety cap

/**
 * GET /api/jobs/[id]/events — Server-Sent Events stream of job progress.
 *
 * The browser attaches one `EventSource` and receives `progress` events
 * carrying the full client-safe job snapshot. On a terminal stage, a final
 * event is sent and the stream closes (EventSource will not reconnect).
 *
 * SSE is chosen over websockets for simplicity (no upgrade, no keepalive
 * ping protocol) and because progress is one-way server→client.
 */
export async function GET(req: NextRequest, { params }: Params) {
  try {
    const principal = requestPrincipal(req.headers, 'job:read');
    const { id } = await params;
    if (isDurableMode()) return await durableEvents(principal, id);
    if (!getQueue().get(id, principal.workspaceId)) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let lastProgress = -1;
      let lastStage = '';
      const startedAt = Date.now();
      let closed = false;

      const send = (event: string, data: unknown) => {
        if (closed) return;
        const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
        controller.enqueue(encoder.encode(payload));
      };

      const finish = () => {
        if (closed) return;
        closed = true;
        clearInterval(timer);
        controller.close();
      };

      const tick = () => {
        const elapsed = Date.now() - startedAt;
        if (elapsed > MAX_LIFETIME_MS) {
          send('error', { message: 'stream lifetime exceeded' });
          finish();
          return;
        }
        const job = getQueue().get(id, principal.workspaceId);
        if (!job) {
          send('error', { message: 'job not found' });
          finish();
          return;
        }
        // Only emit on a change (progress or stage) to keep the wire quiet.
        if (job.progress !== lastProgress || job.stage !== lastStage) {
          lastProgress = job.progress;
          lastStage = job.stage;
          send('progress', toClientJob(job));
        }
        if (isTerminalStage(job.stage)) {
          send('complete', toClientJob(job));
          finish();
        }
      };

      // Send an initial snapshot immediately so the client isn't blind.
      const initial = getQueue().get(id, principal.workspaceId);
      if (!initial) {
        send('error', { message: 'job not found' });
        controller.close();
        return;
      }
      send('progress', toClientJob(initial));
      lastProgress = initial.progress;
      lastStage = initial.stage;
      if (isTerminalStage(initial.stage)) {
        send('complete', toClientJob(initial));
        controller.close();
        closed = true;
        return;
      }

      const timer = setInterval(tick, POLL_MS);

      // Note: client disconnect is detected when the stream errors on next
      // enqueue; the timer's next tick will fail harmlessly. For production
      // with a reverse proxy, wire a request-aborted signal here.
    },
  });

  return new NextResponse(stream, {
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    },
  });
  } catch (err) {
    return authResponse(err) ?? NextResponse.json({ error: 'Unable to stream job' }, { status: 500 });
  }
}

async function durableEvents(principal: ReturnType<typeof requestPrincipal>, id: string): Promise<Response> {
  const platform = getDurablePlatform();
  const initial = await platform.getClientJobOrNull(principal, id);
  if (!initial) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const encoder = new TextEncoder();
  let durableClosed = false;
  let durableTimer: ReturnType<typeof setInterval> | null = null;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let lastProgress = -1;
      let lastStage = '';
      const startedAt = Date.now();
      const send = (event: string, data: unknown) => {
        if (durableClosed) return;
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      };
      const finish = () => {
        if (durableClosed) return;
        durableClosed = true;
        if (durableTimer) clearInterval(durableTimer);
        controller.close();
      };
      const tick = async () => {
        if (durableClosed) return;
        if (Date.now() - startedAt > MAX_LIFETIME_MS) {
          send('error', { message: 'stream lifetime exceeded' });
          finish();
          return;
        }
        try {
          const job = await platform.getClientJobOrNull(principal, id);
          if (!job) {
            send('error', { message: 'job not found' });
            finish();
            return;
          }
          if (job.progress !== lastProgress || job.stage !== lastStage) {
            lastProgress = job.progress;
            lastStage = job.stage;
            send('progress', job);
          }
          if (isTerminalStage(job.stage)) {
            send('complete', job);
            finish();
          }
        } catch {
          send('error', { message: 'unable to read job state' });
          finish();
        }
      };
      durableTimer = setInterval(() => void tick(), POLL_MS);
      void tick();
    },
    cancel() {
      durableClosed = true;
      if (durableTimer) clearInterval(durableTimer);
    },
  });

  return new NextResponse(stream, {
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    },
  });
}
