'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import type { JobSummary } from '@mocap-ts/core/jobs';
import { Badge } from '@/components/ui/badge';
import { Progress } from '@/components/ui/progress';
import { Skeleton } from '@/components/ui/skeleton';
import { stageLabel, stageVariant } from '@/lib/stage';
import { formatProgress, formatTime } from '@/lib/utils';

interface Props {
  initialJobs: JobSummary[];
}

/**
 * Job list with live polling. While any job is non-terminal, we poll every
 * 2s to update progress without needing SSE on a list view (SSE is reserved
 * for the focused detail page).
 */
export function JobList({ initialJobs }: Props) {
  const [jobs, setJobs] = useState<JobSummary[]>(initialJobs);
  const hasRunning = jobs.some(j => !['done', 'failed', 'cancelled'].includes(j.stage));

  useEffect(() => {
    if (!hasRunning) return;
    const timer = setInterval(async () => {
      const r = await fetch('/api/jobs');
      if (r.ok) {
        const data = await r.json();
        setJobs(data.jobs as JobSummary[]);
      }
    }, 2000);
    return () => clearInterval(timer);
  }, [hasRunning]);

  return (
    <div className="overflow-hidden rounded-lg border border-border bg-surface shadow-card">
      {jobs.map((job, i) => (
        <Link
          key={job.id}
          href={`/jobs/${job.id}`}
          className={`group flex items-center gap-4 px-4 py-3 transition-colors hover:bg-surface-hover ${
            i > 0 ? 'border-t border-border' : ''
          }`}
        >
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="truncate text-sm font-medium text-ink">{job.label}</span>
              <Badge variant={stageVariant(job.stage)}>{stageLabel(job.stage)}</Badge>
            </div>
            <div className="mt-0.5 text-2xs text-ink-subtle">
              {job.outputName ?? '—'} · {formatTime(job.createdAt)}
            </div>
          </div>
          <div className="hidden w-32 sm:block">
            {['queued', 'done', 'failed', 'cancelled'].includes(job.stage) ? null : (
              <div className="flex items-center gap-2">
                <Progress value={job.progress * 100} />
                <span className="w-9 text-right text-2xs tabular-nums text-ink-muted">
                  {formatProgress(job.progress)}
                </span>
              </div>
            )}
          </div>
        </Link>
      ))}
    </div>
  );
}

export function JobListSkeleton() {
  return (
    <div className="overflow-hidden rounded-lg border border-border bg-surface shadow-card">
      {Array.from({ length: 3 }).map((_, i) => (
        <div key={i} className={`flex items-center gap-4 px-4 py-3 ${i > 0 ? 'border-t border-border' : ''}`}>
          <Skeleton className="h-4 w-40" />
          <div className="flex-1" />
          <Skeleton className="h-1.5 w-32" />
        </div>
      ))}
    </div>
  );
}
