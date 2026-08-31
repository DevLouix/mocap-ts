import Link from 'next/link';
import { getQueue } from '@/server/jobs';
import { WorkspaceShell } from '@/components/layout/workspace-shell';
import { JobList } from '@/components/workspace/job-list';
import { Button } from '@/components/ui/button';
import { Film, Inbox } from 'lucide-react';

export const dynamic = 'force-dynamic';

/**
 * Home — the workspace's job inbox. Notion-style: a page title, a short
 * description, and a dense list of capture jobs with their stage + progress.
 */
export default function HomePage() {
  const jobs = getQueue().list();

  return (
    <WorkspaceShell active="jobs" actions={
      <Button asChild size="sm" variant="outline">
        <Link href="/new"><Film className="h-4 w-4" /> New capture</Link>
      </Button>
    }>
      <div className="mx-auto w-full max-w-4xl px-8 py-10">
        <header className="mb-6">
          <h1 className="text-2xl font-bold tracking-tight">Motion workspace</h1>
          <p className="mt-1 text-sm text-ink-muted">
            Upload a video or paste a link. Mocap-ts turns it into a BVH you can drag into Blender, Maya, or Unreal.
          </p>
        </header>

        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-ink-muted">Captures</h2>
          <span className="text-2xs text-ink-subtle">{jobs.length} total</span>
        </div>

        {jobs.length === 0 ? (
          <EmptyState />
        ) : (
          <JobList initialJobs={jobs} />
        )}
      </div>
    </WorkspaceShell>
  );
}

function EmptyState() {
  return (
    <div className="flex flex-col items-center justify-center rounded-lg border border-dashed border-border bg-surface-subtle px-6 py-16 text-center">
      <div className="mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-surface-muted text-ink-muted">
        <Inbox className="h-6 w-6" />
      </div>
      <h3 className="text-base font-semibold">No captures yet</h3>
      <p className="mt-1 max-w-sm text-sm text-ink-muted">
        Start by uploading a video or pasting a YouTube link. Your first BVH will appear here.
      </p>
      <Button asChild className="mt-5">
        <Link href="/new"><Film className="h-4 w-4" /> Create your first capture</Link>
      </Button>
    </div>
  );
}
