import { notFound } from 'next/navigation';
import { getQueue } from '@/server/jobs';
import { toClientJob } from '@/lib/types';
import { WorkspaceShell } from '@/components/layout/workspace-shell';
import { JobDetail } from '@/components/workspace/job-detail';
import type { ClientJob } from '@/lib/types';

export const dynamic = 'force-dynamic';

interface Params {
  params: Promise<{ id: string }>;
}

/**
 * Job detail — fetches the initial job snapshot server-side, then hands off
 * to a client component that streams live progress via SSE.
 */
export default async function JobDetailPage({ params }: Params) {
  const { id } = await params;
  const job = getQueue().get(id);
  if (!job) notFound();
  const clientJob = toClientJob(job);

  return (
    <WorkspaceShell active="jobs">
      <JobDetail initialJob={clientJob} />
    </WorkspaceShell>
  );
}
