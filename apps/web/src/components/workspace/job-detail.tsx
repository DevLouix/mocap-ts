'use client';

import { useMemo } from 'react';
import Link from 'next/link';
import { useJob } from '@/lib/use-job';
import { stageLabel, stageVariant } from '@/lib/stage';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Download, ArrowLeft, AlertCircle, Loader2, CheckCircle2, Film, Trash2 } from 'lucide-react';
import { formatProgress, formatTime, formatBytes } from '@/lib/utils';
import { STAGE_ORDER } from '@/lib/stage-order';
import type { ClientJob } from '@/lib/types';
import type { JobStage } from '@mocap-ts/core/jobs';
import { BvhViewer } from '@/components/viewer/bvh-viewer';

const TERMINAL: JobStage[] = ['done', 'failed', 'cancelled'];

export function JobDetail({ initialJob }: { initialJob: ClientJob }) {
  const { job } = useJob(initialJob.id);
  const current = job ?? initialJob;
  const isRunning = !TERMINAL.includes(current.stage);
  const isDone = current.stage === 'done';

  return (
    <div className="mx-auto w-full max-w-5xl px-8 py-8">
      <div className="mb-6 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Button asChild variant="ghost" size="icon">
            <Link href="/"><ArrowLeft className="h-4 w-4" /></Link>
          </Button>
          <div>
            <h1 className="text-xl font-bold tracking-tight">{current.label}</h1>
            <p className="text-2xs text-ink-subtle">
              {current.source.kind === 'url' ? current.source.url : `Uploaded · ${formatBytes(current.source.sizeBytes)}`}
              {' · '}{formatTime(current.createdAt)}
            </p>
          </div>
        </div>
        <Badge variant={stageVariant(current.stage)}>{stageLabel(current.stage)}</Badge>
      </div>

      {/* Download bar — always visible, front and center. */}
      <DownloadBar job={current} />

      <div className="mt-6 grid grid-cols-1 gap-4 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <Card>
            <CardHeader>
              <CardTitle>Pipeline</CardTitle>
              <CardDescription>Stages run sequentially; progress reflects the whole pipeline.</CardDescription>
            </CardHeader>
            <CardContent>
              <Timeline stage={current.stage} progress={current.progress} />
            </CardContent>
          </Card>

          {/* 3D viewer once BVH is ready. */}
          {isDone && current.outputName && (
            <Card className="mt-4">
              <CardHeader>
                <CardTitle>3D preview</CardTitle>
                <CardDescription>Apply this motion to a character and stage it on a background.</CardDescription>
              </CardHeader>
              <CardContent>
                <BvhViewer jobId={current.id} />
              </CardContent>
            </Card>
          )}
        </div>

        <div>
          <Card>
            <CardHeader>
              <CardTitle>Settings</CardTitle>
            </CardHeader>
            <CardContent className="text-sm">
              <dl className="grid grid-cols-2 gap-y-2">
                <dt className="text-ink-muted">Smoothing</dt>
                <dd className="text-right tabular-nums">{current.settings.smoothing.toFixed(2)}</dd>
                <dt className="text-ink-muted">Frame rate</dt>
                <dd className="text-right tabular-nums">{current.settings.fps ?? 'source'}</dd>
                <dt className="text-ink-muted">Hands</dt>
                <dd className="text-right">{current.settings.hands ? 'on' : 'off'}</dd>
                <dt className="text-ink-muted">Output</dt>
                <dd className="text-right truncate">{current.outputName ?? '—'}</dd>
              </dl>
            </CardContent>
          </Card>

          {current.history.length > 0 && (
            <Card className="mt-4">
              <CardHeader>
                <CardTitle>Activity</CardTitle>
              </CardHeader>
              <CardContent>
                <ol className="space-y-2 text-2xs">
                  {current.history.slice(-8).reverse().map((h, i) => (
                    <li key={i} className="flex justify-between gap-2">
                      <span className="truncate text-ink-muted">{h.message}</span>
                      <span className="shrink-0 tabular-nums text-ink-subtle">
                        {formatProgress(h.progress)}
                      </span>
                    </li>
                  ))}
                </ol>
              </CardContent>
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}

function DownloadBar({ job }: { job: ClientJob }) {
  const isReady = job.stage === 'done' && !!job.outputName;

  if (isReady) {
    return (
      <div className="flex items-center justify-between rounded-lg border border-success/20 bg-success/5 px-4 py-3">
        <div className="flex items-center gap-2 text-sm text-success">
          <CheckCircle2 className="h-4 w-4" />
          <span className="font-medium">BVH ready</span>
          <span className="text-ink-muted">· {job.outputName}</span>
        </div>
        <Button asChild>
          <a href={`/api/jobs/${job.id}/download`}>
            <Download className="h-4 w-4" /> Download BVH
          </a>
        </Button>
      </div>
    );
  }

  if (['failed', 'cancelled'].includes(job.stage)) {
    return (
      <div className="flex items-center gap-2 rounded-lg border border-danger/20 bg-danger/5 px-4 py-3 text-sm text-danger">
        <AlertCircle className="h-4 w-4" />
        {job.error ? `Failed: ${job.error}` : 'This capture did not complete.'}
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-border bg-surface px-4 py-3">
      <div className="mb-2 flex items-center justify-between text-sm">
        <span className="flex items-center gap-2 text-ink-muted">
          {job.stage === 'queued' ? <Loader2 className="h-4 w-4" /> : <Film className="h-4 w-4" />}
          {job.message ?? stageLabel(job.stage)}
        </span>
        <span className="tabular-nums text-ink-muted">{formatProgress(job.progress)}</span>
      </div>
      <Progress value={job.progress * 100} />
    </div>
  );
}

function Timeline({ stage, progress }: { stage: JobStage; progress: number }) {
  const currentIndex = STAGE_ORDER.indexOf(stage);
  return (
    <div className="space-y-3">
      {STAGE_ORDER.filter(s => s !== 'queued').map((s, i) => {
        const done = currentIndex > i || stage === 'done';
        const active = currentIndex === i && stage !== 'done';
        return (
          <div key={s} className="flex items-center gap-3">
            <div className={`flex h-5 w-5 items-center justify-center rounded-full border text-2xs ${
              done ? 'border-success bg-success text-white' :
              active ? 'border-accent bg-accent text-white' :
              'border-border bg-surface text-ink-subtle'
            }`}>
              {done ? <CheckCircle2 className="h-3 w-3" /> : active ? <Loader2 className="h-3 w-3 animate-spin" /> : i + 1}
            </div>
            <span className={`text-sm ${done || active ? 'text-ink' : 'text-ink-subtle'}`}>{stageLabel(s)}</span>
            {active && (
              <span className="ml-auto text-2xs tabular-nums text-ink-muted">{formatProgress(progress)}</span>
            )}
          </div>
        );
      })}
    </div>
  );
}
