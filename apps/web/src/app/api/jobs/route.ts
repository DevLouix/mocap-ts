import 'server-only';
import { NextRequest, NextResponse } from 'next/server';
import { writeFileSync, statSync } from 'node:fs';
import { getQueue, uploadPath } from '@/server/jobs';
import { toClientJob } from '@/lib/types';
import { isVideoUrl } from '@mocap-ts/core/video/decoder';
import { DEFAULT_JOB_SETTINGS, type JobSettings } from '@mocap-ts/core/jobs/queue';

const MAX_UPLOAD_BYTES = 1024 * 1024 * 1024; // 1 GB — pose estimation is the bottleneck, not size
const ALLOWED_EXTS = new Set(['.mp4', '.mov', '.mkv', '.webm', '.avi', '.m4v']);
const ALLOWED_URL_HOSTS_RE =
  /^(youtube\.com|youtu\.be|vimeo\.com|streamable\.com|twitch\.tv|dailymotion\.com)$/i;

/**
 * GET /api/jobs — list all jobs (newest first) as ClientJob summaries.
 */
export async function GET() {
  const queue = getQueue();
  const jobs = queue.list();
  // Summaries are already client-safe; return as-is.
  return NextResponse.json({ jobs });
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
  // The worker loop is started once at server boot via instrumentation.ts,
  // so this route stays TF-free and only touches the queue.
  const queue = getQueue();
  const contentType = req.headers.get('content-type') ?? '';

  try {
    if (contentType.startsWith('multipart/form-data')) {
      return await handleUpload(req, queue);
    }
    if (contentType.includes('application/json')) {
      return await handleUrl(req, queue);
    }
    return NextResponse.json({ error: 'Unsupported content type' }, { status: 415 });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    return NextResponse.json({ error: message }, { status: 400 });
  }
}

async function handleUpload(req: NextRequest, queue: ReturnType<typeof getQueue>) {
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

  const settings = parseSettings(form);
  // Create the job first so we have an id, then save the upload to that id's path.
  const job = queue.enqueue(
    { kind: 'upload', filename: file.name, path: '', mimeType: file.type, sizeBytes: file.size },
    settings,
  );
  const path = uploadPath(job.id, file.name);
  const buf = Buffer.from(await file.arrayBuffer());
  writeFileSync(path, buf);
  // Patch the job with the real path now that the file is saved.
  queue.update(job.id, { outputBvhPath: undefined });

  return NextResponse.json({ job: toClientJob({ ...queue.get(job.id)!, source: { kind: 'upload', filename: file.name, path, mimeType: file.type, sizeBytes: file.size } }) }, { status: 201 });
}

async function handleUrl(req: NextRequest, queue: ReturnType<typeof getQueue>) {
  const body = await req.json().catch(() => null);
  if (!body || typeof body.url !== 'string') {
    return NextResponse.json({ error: 'Missing "url"' }, { status: 400 });
  }
  const url = body.url.trim();
  if (!isVideoUrl(url)) {
    return NextResponse.json({ error: 'Not a valid URL' }, { status: 400 });
  }
  let host: string;
  try {
    host = new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return NextResponse.json({ error: 'Invalid URL' }, { status: 400 });
  }
  // Loosen the host allowlist: yt-dlp supports many sites, but we still
  // reject obvious non-video URLs to avoid surprise workloads.
  if (!ALLOWED_URL_HOSTS_RE.test(host) && !host.includes('.')) {
    return NextResponse.json({ error: `Unsupported host: ${host}` }, { status: 400 });
  }

  const settings = parseSettings({ ...body });
  const job = queue.enqueue({ kind: 'url', url }, settings);
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
