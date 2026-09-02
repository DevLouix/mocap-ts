import 'server-only';
import { NextRequest, NextResponse } from 'next/server';
import { existsSync, createReadStream, statSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { getJobDirs, getQueue } from '@/server/jobs';
import { authResponse, requestPrincipal, requireJobWorkspace } from '@/server/auth';
import { getDurablePlatform, isDurableMode } from '@/server/durable';

interface Params {
  params: Promise<{ id: string }>;
}

/**
 * GET /api/jobs/[id]/download — stream the produced BVH file.
 *
 * Returns 404 if the job has no BVH yet (still running, or failed). The
 * `outputBvhPath` is server-only metadata, never serialized to the client;
 * the route resolves it from the queue.
 */
export async function GET(req: NextRequest, { params }: Params) {
  try {
    const principal = requestPrincipal(req.headers, 'job:download');
    const { id } = await params;
    if (isDurableMode()) {
      const artifact = await getDurablePlatform().downloadArtifact(principal, id);
      if (!artifact) return NextResponse.json({ error: 'BVH not ready' }, { status: 404 });
      const filename = artifact.filename.replace(/[^\w.-]+/g, '_');
      const contentType = filename.toLowerCase().endsWith('.fbx')
        ? 'application/octet-stream'
        : 'text/plain; charset=utf-8';
      return new NextResponse(artifact.bytes as unknown as BodyInit, {
        status: 200,
        headers: {
          'content-type': contentType,
          'content-length': String(artifact.bytes.byteLength),
          'content-disposition': `attachment; filename="${filename}"`,
          'cache-control': 'no-store',
        },
      });
    }
    const job = getQueue().get(id, principal.workspaceId);
    if (!job) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    requireJobWorkspace(principal, job.workspaceId, 'job:download');
  const bvhPath = job.outputBvhPath;
  if (!bvhPath || !existsSync(bvhPath)) {
    return NextResponse.json({ error: 'BVH not ready' }, { status: 404 });
  }

  const outputRoot = resolve(getJobDirs().outDir);
  const resolvedPath = resolve(bvhPath);
  if (resolvedPath !== outputRoot && !resolvedPath.startsWith(`${outputRoot}/`)) {
    return NextResponse.json({ error: 'Artifact is outside the managed output directory' }, { status: 404 });
  }
  const stat = statSync(resolvedPath);
  if (!stat.isFile()) return NextResponse.json({ error: 'Artifact is not a file' }, { status: 404 });
  const filename = basename(job.outputName ?? basename(bvhPath)).replace(/[^\w.-]+/g, '_');
  const lower = filename.toLowerCase();
  const contentType = lower.endsWith('.fbx')
    ? 'application/octet-stream'
    : 'text/plain; charset=utf-8';
  const stream = createReadStream(resolvedPath);
  const webStream = Readable.toWeb(stream) as unknown as ReadableStream<Uint8Array>;

    return new NextResponse(webStream, {
    status: 200,
    headers: {
      'content-type': contentType,
      'content-length': String(stat.size),
      'content-disposition': `attachment; filename="${filename}"`,
      'cache-control': 'no-store',
    },
    });
  } catch (err) {
    return authResponse(err) ?? NextResponse.json({ error: 'Unable to download artifact' }, { status: 500 });
  }
}
