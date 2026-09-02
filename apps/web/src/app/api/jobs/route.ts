import 'server-only';
import { NextRequest, NextResponse } from 'next/server';
import { createWriteStream, rmSync } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { getQueue, uploadPath } from '@/server/jobs';
import { toClientJob } from '@/lib/types';
import { DEFAULT_JOB_SETTINGS, type JobSettings } from '@mocap-ts/core/jobs/queue';
import { validateRemoteVideoUrl } from '@mocap-ts/core/video/url-policy';
import { hasSupportedVideoSignature } from '@mocap-ts/core/video/file-policy';
import { authResponse, requestPrincipal } from '@/server/auth';
import { getDurablePlatform, isDurableMode } from '@/server/durable';

export const runtime = 'nodejs';
export const maxDuration = 300;

const MAX_UPLOAD_BYTES = 1024 * 1024 * 1024; // 1 GB — pose estimation is the bottleneck, not size
const ALLOWED_EXTS = new Set(['.mp4', '.mov', '.mkv', '.webm', '.avi', '.m4v']);

/**
 * GET /api/jobs — list all jobs (newest first) as ClientJob summaries.
 */
export async function GET(req: NextRequest) {
  try {
    const principal = requestPrincipal(req.headers, 'job:read');
    if (isDurableMode()) {
      const jobs = await getDurablePlatform().listClientJobs(principal);
      return NextResponse.json({ jobs });
    }
    const jobs = getQueue().list(principal.workspaceId);
    return NextResponse.json({ jobs });
  } catch (err) {
    return authResponse(err) ?? NextResponse.json({ error: 'Unable to list jobs' }, { status: 500 });
  }
}

/**
 * POST /api/jobs — submit a new job.
 *
 * Two content types:
 *   - multipart/form-data with a `file` field (and optional settings)
 *   - application/json with { url, fps?, hands?, smoothing? }
 *
 * Settings are validated and clamped server-side; the worker re-reads them
 * from the persisted job record, so the client never drives behavior directly.
 */
export async function POST(req: NextRequest) {
  const contentType = req.headers.get('content-type') ?? '';
  try {
    const principal = requestPrincipal(req.headers, 'job:create');
    if (isDurableMode()) {
      if (contentType.startsWith('multipart/form-data')) return await handleDurableUpload(req, principal);
      if (contentType.includes('application/json')) return await handleDurableUrl(req, principal);
      return NextResponse.json({ error: 'Unsupported content type' }, { status: 415 });
    }
    const queue = getQueue();
    if (contentType.startsWith('multipart/form-data')) {
      return await handleUpload(req, queue, principal);
    }
    if (contentType.includes('application/json')) {
      return await handleUrl(req, queue, principal);
    }
    return NextResponse.json({ error: 'Unsupported content type' }, { status: 415 });
  } catch (err) {
    return authResponse(err) ?? NextResponse.json({ error: err instanceof Error ? err.message : 'Unknown error' }, { status: 400 });
  }
}

async function handleDurableUpload(req: NextRequest, principal: ReturnType<typeof requestPrincipal>) {
  const rawContentLength = req.headers.get('content-length');
  const contentLength = rawContentLength ? Number(rawContentLength) : 0;
  if (rawContentLength && (!Number.isFinite(contentLength) || contentLength < 0)) {
    return NextResponse.json({ error: 'Invalid content length' }, { status: 400 });
  }
  if (contentLength > MAX_UPLOAD_BYTES + 1024 * 1024) {
    return NextResponse.json({ error: 'Request too large (max 1 GB)' }, { status: 413 });
  }
  const form = await req.formData();
  const file = form.get('file');
  if (!(file instanceof File)) return NextResponse.json({ error: 'Missing "file" field' }, { status: 400 });
  if (file.size === 0) return NextResponse.json({ error: 'Empty file' }, { status: 400 });
  if (file.size > MAX_UPLOAD_BYTES) return NextResponse.json({ error: 'File too large (max 1 GB)' }, { status: 413 });
  const ext = file.name.slice(file.name.lastIndexOf('.')).toLowerCase();
  if (!ALLOWED_EXTS.has(ext)) {
    return NextResponse.json({ error: `Unsupported file type ${ext}. Allowed: ${[...ALLOWED_EXTS].join(', ')}` }, { status: 415 });
  }
  const signature = new Uint8Array(await file.slice(0, 64).arrayBuffer());
  if (!hasSupportedVideoSignature(file.name, signature)) {
    return NextResponse.json({ error: 'File contents do not match a supported video format' }, { status: 415 });
  }
  const settings = parseSettings(form);
  const job = await getDurablePlatform().createUpload(principal, {
    filename: file.name,
    mimeType: file.type,
    sizeBytes: file.size,
    body: Readable.fromWeb(file.stream() as unknown as import('node:stream/web').ReadableStream<Uint8Array>),
  }, settings);
  return NextResponse.json({ job }, { status: 201 });
}

async function handleDurableUrl(req: NextRequest, principal: ReturnType<typeof requestPrincipal>) {
  const body = await req.json().catch(() => null);
  if (!body || typeof body.url !== 'string') return NextResponse.json({ error: 'Missing "url"' }, { status: 400 });
  const url = body.url.trim();
  try {
    await validateRemoteVideoUrl(url);
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Invalid video URL' }, { status: 400 });
  }
  const job = await getDurablePlatform().createUrl(principal, url, parseSettings({ ...body }));
  return NextResponse.json({ job }, { status: 201 });
}

async function handleUpload(req: NextRequest, queue: ReturnType<typeof getQueue>, principal: ReturnType<typeof requestPrincipal>) {
  const rawContentLength = req.headers.get('content-length');
  const contentLength = rawContentLength ? Number(rawContentLength) : 0;
  if (rawContentLength && (!Number.isFinite(contentLength) || contentLength < 0)) {
    return NextResponse.json({ error: 'Invalid content length' }, { status: 400 });
  }
  if (contentLength > MAX_UPLOAD_BYTES + 1024 * 1024) {
    return NextResponse.json({ error: 'Request too large (max 1 GB)' }, { status: 413 });
  }
  const form = await req.formData();
  const file = form.get('file');
  if (!(file instanceof File)) {
    return NextResponse.json({ error: 'Missing "file" field' }, { status: 400 });
  }
  if (file.size === 0) {
    return NextResponse.json({ error: 'Empty file' }, { status: 400 });
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    return NextResponse.json({ error: 'File too large (max 1 GB)' }, { status: 413 });
  }
  const ext = file.name.slice(file.name.lastIndexOf('.')).toLowerCase();
  if (!ALLOWED_EXTS.has(ext)) {
    return NextResponse.json(
      { error: `Unsupported file type ${ext}. Allowed: ${[...ALLOWED_EXTS].join(', ')}` },
      { status: 415 },
    );
  }

  const signature = new Uint8Array(await file.slice(0, 64).arrayBuffer());
  if (!hasSupportedVideoSignature(file.name, signature)) {
    return NextResponse.json({ error: 'File contents do not match a supported video format' }, { status: 415 });
  }

  const settings = parseSettings(form);
  // Create the job first so we have an id, then save the upload to that id's path.
  const job = queue.enqueue(
    { kind: 'upload', filename: file.name, path: '', mimeType: file.type, sizeBytes: file.size },
    settings,
    { organizationId: principal.organizationId, workspaceId: principal.workspaceId, createdBy: principal.id },
  );
  const path = uploadPath(job.id, file.name);
  try {
    await pipeline(
      Readable.fromWeb(file.stream() as unknown as import('node:stream/web').ReadableStream<Uint8Array>),
      createWriteStream(path, { flags: 'wx' }),
    );
    // Write the concrete path back into the job source — the worker reads
    // `source.path` to locate the video.
    queue.patchSource(job.id, { path });
    queue.dispatch(job.id);
  } catch (err) {
    rmSync(path, { force: true });
    queue.remove(job.id);
    throw err;
  }

  return NextResponse.json({ job: toClientJob(queue.get(job.id)!) }, { status: 201 });
}

async function handleUrl(req: NextRequest, queue: ReturnType<typeof getQueue>, principal: ReturnType<typeof requestPrincipal>) {
  const body = await req.json().catch(() => null);
  if (!body || typeof body.url !== 'string') {
    return NextResponse.json({ error: 'Missing "url"' }, { status: 400 });
  }
  const url = body.url.trim();
  try {
    await validateRemoteVideoUrl(url);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Invalid video URL' },
      { status: 400 },
    );
  }

  const settings = parseSettings({ ...body });
  if (isDurableMode()) {
    const job = await getDurablePlatform().createUrl(principal, url, settings);
    return NextResponse.json({ job }, { status: 201 });
  }
  const job = queue.enqueue(
    { kind: 'url', url },
    settings,
    { organizationId: principal.organizationId, workspaceId: principal.workspaceId, createdBy: principal.id },
  );
  queue.dispatch(job.id);
  return NextResponse.json({ job: toClientJob(queue.get(job.id)!) }, { status: 201 });
}

/** Parse + clamp pipeline settings from a form/json payload. */
function parseSettings(input: Record<string, unknown> | FormData): JobSettings {
  const get = (k: string): unknown =>
    input instanceof FormData ? input.get(k) : input[k];

  let fps: number | undefined;
  const rawFps = get('fps');
  if (rawFps != null && rawFps !== '') {
    const n = Number(rawFps);
    if (Number.isFinite(n) && n > 0 && n <= 240) fps = n;
  }
  const rawHands = get('hands');
  const hands = rawHands == null ? DEFAULT_JOB_SETTINGS.hands : String(rawHands) !== 'false';
  const rawSmoothing = get('smoothing');
  let smoothing = DEFAULT_JOB_SETTINGS.smoothing;
  if (rawSmoothing != null && rawSmoothing !== '') {
    const n = Number(rawSmoothing);
    if (Number.isFinite(n) && n >= 0 && n <= 1) smoothing = n;
  }
  const rawFormat = get('format');
  const format = rawFormat === 'fbx' ? 'fbx' : rawFormat === 'bvh' ? 'bvh' : undefined;
  // Advanced IK options.
  const rawMinVis = get('minVisibility');
  let minVisibility: number | undefined;
  if (rawMinVis != null && rawMinVis !== '') {
    const n = Number(rawMinVis);
    if (Number.isFinite(n) && n >= 0 && n <= 1) minVisibility = n;
  }
  const rawGroundLock = get('groundLockFeet');
  const groundLockFeet = rawGroundLock == null ? false : String(rawGroundLock) === 'true';
  const rawMultipose = get('multipose');
  const multipose = rawMultipose == null ? false : String(rawMultipose) === 'true';
  return { fps, hands, smoothing, format, minVisibility, groundLockFeet, multipose };
}
