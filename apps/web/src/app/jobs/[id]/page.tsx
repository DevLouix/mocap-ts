import { notFound } from 'next/navigation';
import { getQueue } from '@/server/jobs';
import { getDurablePlatform, isDurableMode } from '@/server/durable';
import { toClientJob } from '@/lib/types';
import { WorkspaceShell } from '@/components/layout/workspace-shell';
import { JobDetail } from '@/components/workspace/job-detail';
import type { ClientJob } from '@/lib/types';
import { headers } from 'next/headers';
import { requestPrincipal } from '@/server/auth';

export const dynamic = 'force-dynamic';

interface Params {
  params: Promise<{ id: string }>;
}

/**
 * Job detail — fetches the initial job snapshot server-side, then hands off
 * to a client component that streams live progress via SSE.
 */
export default async function JobDetailPage({ params }: Params) {
  const principal = requestPrincipal(await headers(), 'job:read');
  const { id } = await params;
  const clientJob = isDurableMode()
    ? await getDurablePlatform().getClientJobOrNull(principal, id)
    : (() => {
        const job = getQueue().get(id, principal.workspaceId);
        return job ? toClientJob(job) : null;
      })();
  if (!clientJob) notFound();

  return (
    <WorkspaceShell active="jobs">
      <JobDetail initialJob={clientJob} />
    </WorkspaceShell>
  );
}
