import 'server-only';
import { NextRequest, NextResponse } from 'next/server';
import { existsSync, createReadStream, statSync } from 'node:fs';
import { basename } from 'node:path';
import { Readable } from 'node:stream';
import { getQueue } from '@/server/jobs';

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
export async function GET(_req: NextRequest, { params }: Params) {
  const { id } = await params;
  const job = getQueue().get(id);
  if (!job) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  const bvhPath = job.outputBvhPath;
  if (!bvhPath || !existsSync(bvhPath)) {
    return NextResponse.json({ error: 'BVH not ready' }, { status: 404 });
  }

  const stat = statSync(bvhPath);
  const filename = job.outputName ?? basename(bvhPath);
  const lower = filename.toLowerCase();
  const contentType = lower.endsWith('.fbx')
    ? 'application/octet-stream'
    : 'text/plain; charset=utf-8';
  const stream = createReadStream(bvhPath);
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
}
