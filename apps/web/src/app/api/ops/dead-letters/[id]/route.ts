import 'server-only';
import { NextRequest, NextResponse } from 'next/server';
import { authResponse, requestPrincipal } from '@/server/auth';
import { getDurablePlatform, isDurableMode } from '@/server/durable';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface Params {
  params: Promise<{ id: string }>;
}

/** POST /api/ops/dead-letters/[id] — reset and requeue one dead letter. */
export async function POST(req: NextRequest, { params }: Params) {
  try {
    if (!isDurableMode()) {
      return NextResponse.json({ error: 'Operational job controls require durable persistence mode' }, { status: 409 });
    }
    const principal = requestPrincipal(req.headers);
    const { id } = await params;
    const redriven = await getDurablePlatform().redrive(principal, id);
    return redriven
      ? NextResponse.json({ ok: true, jobId: id })
      : NextResponse.json({ error: 'Dead-letter job not found or is not eligible for redrive' }, { status: 404 });
  } catch (error) {
    return authResponse(error) ?? NextResponse.json({ error: error instanceof Error ? error.message : 'Unable to redrive job' }, { status: 400 });
  }
}
