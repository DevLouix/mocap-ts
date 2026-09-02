import 'server-only';
import { NextRequest, NextResponse } from 'next/server';
import { authResponse, requestPrincipal } from '@/server/auth';
import { getDurablePlatform, isDurableMode } from '@/server/durable';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** GET /api/ops/dead-letters — inspect exhausted durable jobs. */
export async function GET(req: NextRequest) {
  try {
    if (!isDurableMode()) {
      return NextResponse.json({ error: 'Operational job controls require durable persistence mode' }, { status: 409 });
    }
    const principal = requestPrincipal(req.headers);
    const jobs = await getDurablePlatform().listDeadLetters(principal);
    return NextResponse.json({ jobs });
  } catch (error) {
    return authResponse(error) ?? NextResponse.json({ error: error instanceof Error ? error.message : 'Unable to list dead letters' }, { status: 400 });
  }
}
