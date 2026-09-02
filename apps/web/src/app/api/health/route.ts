import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** Liveness only: dependency readiness belongs in a separate operational check. */
export function GET() {
  return NextResponse.json({ status: 'ok' });
}
