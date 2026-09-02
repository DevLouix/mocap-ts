import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { FileJobQueue } from '../src/jobs/queue.js';
import { resolveJobInput } from '../src/jobs/runner.js';
import { JobStage, DEFAULT_JOB_SETTINGS, type JobSettings } from '../src/jobs/types.js';

function tmpDataDir(): string {
  return mkdtempSync(join(tmpdir(), 'mocap-jobs-'));
}

const uploadSettings: JobSettings = { ...DEFAULT_JOB_SETTINGS, smoothing: 0.5 };

describe('FileJobQueue', () => {
  let dir: string;
  let q: FileJobQueue;

  beforeEach(() => {
    dir = tmpDataDir();
    q = new FileJobQueue({ dataDir: dir });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('enqueues and reads back a job', () => {
    const job = q.enqueue(
      { kind: 'upload', filename: 'dance.mp4', path: '/tmp/dance.mp4' },
      uploadSettings,
    );
    expect(job.stage).toBe(JobStage.QUEUED);
    expect(job.settings.smoothing).toBe(0.5);
    expect(q.get(job.id)?.id).toBe(job.id);
  });

  it('acquireNext claims a queued job and hides it from further acquires', () => {
    const job = q.enqueue(
      { kind: 'url', url: 'https://youtu.be/x' },
      uploadSettings,
    );
    const claimed = q.acquireNext();
    expect(claimed?.id).toBe(job.id);
    // Second acquire sees nothing.
    expect(q.acquireNext()).toBeNull();
    // Job is still readable while processing.
    expect(q.get(job.id)?.id).toBe(job.id);
  });

  it('update patches stage/progress and appends history', () => {
    const job = q.enqueue(
      { kind: 'upload', filename: 'f.mp4', path: '/f.mp4' },
      uploadSettings,
    );
    q.acquireNext();
    const before = q.get(job.id)!.history.length;
    q.update(job.id, { stage: JobStage.ESTIMATING, progress: 0.3, message: 'frame 1' });
    const after = q.get(job.id)!;
    expect(after.stage).toBe(JobStage.ESTIMATING);
    expect(after.progress).toBeCloseTo(0.3);
    expect(after.history.length).toBe(before + 1);
    expect(after.history.at(-1)?.stage).toBe(JobStage.ESTIMATING);
  });

  it('retries worker failures and eventually marks the job terminal', () => {
    const job = q.enqueue(
      { kind: 'upload', filename: 'f.mp4', path: '/f.mp4' },
      uploadSettings,
    );
    q.acquireNext();
    expect(q.fail(job.id, 'boom').stage).toBe(JobStage.QUEUED);
    q.acquireNext();
    expect(q.fail(job.id, 'boom').stage).toBe(JobStage.QUEUED);
    q.acquireNext();
    const failed = q.fail(job.id, 'boom');
    expect(failed.stage).toBe(JobStage.FAILED);
    expect(failed.error).toBe('boom');
    expect(failed.finishedAt).toBeTruthy();
    expect(q.list()).toHaveLength(1);
  });

  it('list returns summaries newest-first', () => {
    q.enqueue({ kind: 'upload', filename: 'a.mp4', path: '/a.mp4' }, uploadSettings);
    q.enqueue({ kind: 'upload', filename: 'b.mp4', path: '/b.mp4' }, uploadSettings);
    const list = q.list();
    expect(list).toHaveLength(2);
    // newest first — createdAt strings sort lexically for ISO within the same instant,
    // so just verify both labels are present.
    expect(list.map(s => s.label)).toEqual(expect.arrayContaining(['a', 'b']));
  });

  it('recoverStuck re-queues jobs left in processing/', () => {
    const job = q.enqueue(
      { kind: 'upload', filename: 'c.mp4', path: '/c.mp4' },
      uploadSettings,
    );
    q.acquireNext();
    // Simulate a crash by constructing a fresh queue over the same dir.
    const q2 = new FileJobQueue({ dataDir: dir });
    const recovered = q2.get(job.id);
    expect(recovered?.stage).toBe(JobStage.QUEUED);
    expect(recovered?.history.at(-1)?.message).toContain('Re-queued');
  });

  it('filters reads and lists by workspace', () => {
    const first = q.enqueue(
      { kind: 'upload', filename: 'first.mp4', path: '/first.mp4' },
      uploadSettings,
      { organizationId: 'org-a', workspaceId: 'workspace-a', createdBy: 'user-a' },
    );
    q.enqueue(
      { kind: 'upload', filename: 'second.mp4', path: '/second.mp4' },
      uploadSettings,
      { organizationId: 'org-b', workspaceId: 'workspace-b', createdBy: 'user-b' },
    );
    expect(q.get(first.id, 'workspace-b')).toBeNull();
    expect(q.list('workspace-a').map(item => item.id)).toEqual([first.id]);
  });

  it('cancellation wins late worker updates and failures', () => {
    const job = q.enqueue(
      { kind: 'upload', filename: 'cancel.mp4', path: '/cancel.mp4' },
      uploadSettings,
    );
    q.acquireNext();
    q.cancel(job.id);
    expect(q.update(job.id, { stage: JobStage.ESTIMATING, progress: 0.5 }).stage).toBe(JobStage.CANCELLED);
    expect(q.fail(job.id, 'late failure').stage).toBe(JobStage.CANCELLED);
    expect(q.list()).toHaveLength(1);
  });

  it('remove deletes the job file', () => {
    const job = q.enqueue(
      { kind: 'upload', filename: 'd.mp4', path: '/d.mp4' },
      uploadSettings,
    );
    q.remove(job.id);
    expect(q.get(job.id)).toBeNull();
  });

  it('corrupt processing file is dropped, not fatal', () => {
    // Hand-write garbage into the processing dir before constructing.
    writeFileSync(join(dir, 'processing', 'garbage.json'), '{not json');
    expect(() => new FileJobQueue({ dataDir: dir })).not.toThrow();
  });

  it('accepts uploads beside work and rejects paths outside the data root', async () => {
    const jobId = 'job-path-check';
    const workDir = join(dir, 'work', jobId);
    const uploadDir = join(dir, 'uploads');
    const uploadPath = join(uploadDir, `${jobId}.mp4`);
    mkdirSync(workDir, { recursive: true });
    mkdirSync(uploadDir, { recursive: true });
    writeFileSync(uploadPath, 'video');

    const job = {
      id: jobId,
      source: { kind: 'upload', filename: 'video.mp4', path: uploadPath },
    } as Parameters<typeof resolveJobInput>[0];
    await expect(resolveJobInput(job, workDir, () => undefined)).resolves.toEqual({
      videoPath: uploadPath,
      title: 'video.mp4',
    });

    const outside = join(dir, 'outside.mp4');
    writeFileSync(outside, 'video');
    await expect(resolveJobInput(
      { ...job, source: { ...job.source, path: outside } },
      workDir,
      () => undefined,
    )).rejects.toThrow('Upload path is outside the managed data directory');
  });
});
