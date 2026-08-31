import 'server-only';
import { serve } from 'inngest/next';
import { inngest } from '@/server/inngest/client';
import { runMocapJob } from '@/server/inngest/functions';

/**
 * Inngest serve endpoint: POST /api/inngest (Inngest calls this to register
 * functions and receive invocations), GET /api/inngest (the dashboard
 * landing for local dev).
 *
 * Only meaningful when `MOCAP_QUEUE=inngest` is set; harmless otherwise.
 */
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

export const { GET, POST, PUT } = serve({
  client: inngest,
  functions: [runMocapJob],
});
