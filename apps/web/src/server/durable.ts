import 'server-only';
import { randomUUID } from 'node:crypto';
import { createDatabase, JobRepository, WorkerJobRepository, UploadSessionRepository, type PersistedJob, type TenantContext } from '@mocap-ts/db';
import { createObjectStorage } from '@mocap-ts/storage';
import { BullMotionQueue, type MotionJobPayload } from '@mocap-ts/queue';
import type { Principal, WorkspacePermission, WorkspaceRole } from '@mocap-ts/core/identity';
import { AuthError, requirePermission } from '@/server/auth';
import type { JobSettings, JobStage, JobSummary } from '@mocap-ts/core/jobs/queue';
import { hasSupportedVideoSignature } from '@mocap-ts/core/video/file-policy';
import type { ClientJob } from '@/lib/types';

const DEFAULT_PART_SIZE = 8 * 1024 * 1024;
const MAX_MULTIPART_PARTS = 10_000;
const UPLOAD_SESSION_TTL_MS = 24 * 60 * 60 * 1000;

export interface DurableUploadInput {
  filename: string;
  mimeType?: string;
  sizeBytes: number;
  body: import('node:stream').Readable;
}

export function isDurableMode(): boolean {
  return process.env.MOCAP_PERSISTENCE === 'durable';
}

function context(principal: Principal): TenantContext {
  return {
    organizationId: principal.organizationId,
    workspaceId: principal.workspaceId,
    principalId: principal.id,
  };
}

/**
 * Durable control-plane services. This class owns provider composition so
 * route handlers depend on application operations rather than pg/S3/BullMQ.
 */
export class DurablePlatform {
  readonly database = createDatabase();
  private initialized: Promise<void> | null = null;
  readonly jobs = new JobRepository(this.database);
  readonly workerJobs = new WorkerJobRepository(this.database.pool);
  readonly uploads = new UploadSessionRepository(this.database.pool);
  readonly storage = createObjectStorage();
  readonly queue = new BullMotionQueue({
    redisUrl: process.env.REDIS_URL,
    queueName: process.env.MOCAP_QUEUE_NAME,
  });

  private async initialize(principal: Principal, permission: WorkspacePermission): Promise<void> {
    if (!this.initialized) {
      this.initialized = this.database.migrate();
    }
    await this.initialized;
    if ((process.env.MOCAP_AUTH_MODE ?? 'local') === 'local') {
      await this.database.ensureLocalTenant(context(principal));
      requirePermission(principal, permission);
      return;
    }
    const role = await this.database.workspaceMembershipRole(
      principal.organizationId,
      principal.workspaceId,
      principal.id,
    );
    const validRoles: WorkspaceRole[] = ['owner', 'admin', 'editor', 'reviewer', 'viewer'];
    if (!role || !validRoles.includes(role as WorkspaceRole)) {
      throw new AuthError(403, 'Authenticated principal is not a member of this workspace');
    }
    requirePermission({ ...principal, roles: [role as WorkspaceRole] }, permission);
  }

  async migrate(): Promise<void> {
    await this.database.migrate();
  }

  async initiateMultipart(principal: Principal, input: {
    filename: string;
    mimeType?: string;
    sizeBytes: number;
    settings: JobSettings;
  }): Promise<{ sessionId: string; partSize: number; partCount: number; expiresAt: string }> {
    await this.initialize(principal, 'job:create');
    await this.storage.ensureBucket();
    if (!Number.isSafeInteger(input.sizeBytes) || input.sizeBytes <= 0) throw new Error('Invalid upload size');
    const partSize = Math.max(DEFAULT_PART_SIZE, Math.ceil(input.sizeBytes / MAX_MULTIPART_PARTS));
    const partCount = Math.ceil(input.sizeBytes / partSize);
    if (partCount < 1 || partCount > MAX_MULTIPART_PARTS) throw new Error('Upload has too many parts');
    const sessionId = randomUUID();
    const objectKey = this.storage.tenantKey(principal.organizationId, principal.workspaceId, sessionId, input.filename);
    let multipart: Awaited<ReturnType<typeof this.storage.beginMultipart>>;
    try {
      multipart = await this.storage.beginMultipart(
        { bucket: this.storage.bucket, key: objectKey },
        input.mimeType ?? 'application/octet-stream',
      );
      const expiresAt = new Date(Date.now() + UPLOAD_SESSION_TTL_MS).toISOString();
      await this.uploads.create(context(principal), {
        id: sessionId,
        bucket: this.storage.bucket,
        objectKey,
        providerUploadId: multipart.uploadId,
        filename: input.filename,
        mimeType: input.mimeType,
        sizeBytes: input.sizeBytes,
        partSize,
        partCount,
        settings: input.settings as unknown as Record<string, unknown>,
        expiresAt,
      });
      return { sessionId, partSize, partCount, expiresAt };
    } catch (error) {
      if (multipart!) await this.storage.abortMultipart(multipart).catch(() => undefined);
      throw error;
    }
  }

  async signMultipartPart(principal: Principal, sessionId: string, partNumber: number): Promise<{ url: string; partNumber: number }> {
    await this.initialize(principal, 'job:create');
    const session = await this.uploads.get(context(principal), sessionId);
    if (!session) throw new Error('Upload session not found');
    if (session.status !== 'active' || Date.parse(session.expiresAt) <= Date.now()) {
      throw new Error('Upload session is expired or no longer active');
    }
    if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > session.partCount) {
      throw new Error('Invalid multipart part number');
    }
    const url = await this.storage.signedPartUpload({
      uploadId: session.providerUploadId,
      address: { bucket: session.bucket, key: session.objectKey },
    }, partNumber);
    return { url, partNumber };
  }

  async completeMultipart(principal: Principal, sessionId: string): Promise<ClientJob> {
    await this.initialize(principal, 'job:create');
    await this.storage.ensureBucket();
    const tenant = context(principal);
    const session = await this.uploads.get(tenant, sessionId);
    if (!session) throw new Error('Upload session not found');
    if (session.status === 'completed' && session.jobId) return this.getClientJob(principal, session.jobId);
    if (session.status !== 'active' || Date.parse(session.expiresAt) <= Date.now()) {
      await this.uploads.markExpired(tenant, sessionId).catch(() => undefined);
      throw new Error('Upload session is expired or no longer active');
    }
    const multipart = { uploadId: session.providerUploadId, address: { bucket: session.bucket, key: session.objectKey } };
    const parts = await this.storage.listParts(multipart);
    const ordered = [...parts].sort((a, b) => a.partNumber - b.partNumber);
    const expectedLastPartSize = session.sizeBytes - session.partSize * (session.partCount - 1);
    const complete = ordered.length === session.partCount && ordered.every((part, index) => {
      const expectedSize = index === session.partCount - 1 ? expectedLastPartSize : session.partSize;
      return part.partNumber === index + 1
        && typeof part.etag === 'string'
        && part.etag.length > 0
        && part.sizeBytes === expectedSize;
    });
    if (!complete) throw new Error('Upload is incomplete or has invalid part sizes');

    let preserveObject = false;
    try {
      await this.storage.completeMultipart(multipart, ordered);
      const metadata = await this.storage.head({ bucket: session.bucket, key: session.objectKey });
      if (!metadata || metadata.contentLength !== session.sizeBytes) {
        throw new Error('Uploaded object size does not match the declared size');
      }
      const signature = await this.storage.downloadPrefix({ bucket: session.bucket, key: session.objectKey }, 64);
      if (!hasSupportedVideoSignature(session.filename, signature)) {
        throw new Error('Uploaded object contents do not match a supported video format');
      }

      const jobId = randomUUID();
      const source = {
        kind: 'upload',
        filename: session.filename,
        objectKey: session.objectKey,
        mimeType: session.mimeType,
        sizeBytes: session.sizeBytes,
      };
      await this.jobs.create(tenant, {
        id: jobId,
        source,
        settings: session.settings,
      });
      const marked = await this.uploads.complete(tenant, sessionId, jobId, ordered);
      if (!marked) {
        await this.jobs.delete(tenant, jobId);
        const finalized = await this.uploads.get(tenant, sessionId);
        if (finalized?.status === 'completed' && finalized.jobId) {
          preserveObject = true;
          return this.getClientJob(principal, finalized.jobId);
        }
        throw new Error('Upload session was finalized concurrently');
      }
      preserveObject = true;
      try {
        await this.dispatch({
          jobId,
          organizationId: tenant.organizationId,
          workspaceId: tenant.workspaceId,
          source,
          settings: session.settings,
        });
      } catch (error) {
        await this.jobs.update(tenant, jobId, {
          stage: 'failed',
          error: error instanceof Error ? error.message : String(error),
          finishedAt: new Date().toISOString(),
        });
        throw error;
      }
      return this.getClientJob(principal, jobId);
    } catch (error) {
      // Once the session is marked completed, retain the source object even if
      // queue dispatch fails: the job can be retried/reconciled safely. Before
      // that point, remove the incomplete or invalid object.
      if (!preserveObject) {
        await this.storage.delete({ bucket: session.bucket, key: session.objectKey }).catch(() => undefined);
        await this.uploads.abort(tenant, sessionId).catch(() => undefined);
      }
      throw error;
    }
  }

  async multipartStatus(principal: Principal, sessionId: string): Promise<{
    sessionId: string;
    status: string;
    partSize: number;
    partCount: number;
    uploadedParts: number[];
    uploadedBytes: number;
    filename: string;
    sizeBytes: number;
    expiresAt: string;
    jobId?: string;
  } | null> {
    await this.initialize(principal, 'job:create');
    const session = await this.uploads.get(context(principal), sessionId);
    if (!session) return null;
    const uploadedParts = session.status === 'active'
      ? await this.storage.listParts({
          uploadId: session.providerUploadId,
          address: { bucket: session.bucket, key: session.objectKey },
        })
      : session.parts;
    return {
      sessionId: session.id,
      status: session.status,
      partSize: session.partSize,
      partCount: session.partCount,
      uploadedParts: uploadedParts.map(part => part.partNumber),
      uploadedBytes: uploadedParts.reduce((total, part) => {
        if (typeof part.sizeBytes === 'number') return total + part.sizeBytes;
        return total + (part.partNumber === session.partCount
          ? Math.max(0, session.sizeBytes - session.partSize * (session.partCount - 1))
          : session.partSize);
      }, 0),
      filename: session.filename,
      sizeBytes: session.sizeBytes,
      expiresAt: session.expiresAt,
      jobId: session.jobId,
    };
  }

  async abortMultipart(principal: Principal, sessionId: string): Promise<boolean> {
    await this.initialize(principal, 'job:create');
    const tenant = context(principal);
    const session = await this.uploads.get(tenant, sessionId);
    if (!session) return false;
    const result = await this.uploads.abort(tenant, sessionId);
    if (result) {
      await this.storage.abortMultipart({
        uploadId: session.providerUploadId,
        address: { bucket: session.bucket, key: session.objectKey },
      }).catch(() => undefined);
      await this.storage.delete({ bucket: session.bucket, key: session.objectKey }).catch(() => undefined);
    }
    return result;
  }

  async createUpload(principal: Principal, input: DurableUploadInput, settings: JobSettings): Promise<ClientJob> {
    await this.initialize(principal, 'job:create');
    await this.storage.ensureBucket();
    const tenant = context(principal);
    const id = randomUUID();
    const objectKey = this.storage.tenantKey(
      principal.organizationId,
      principal.workspaceId,
      id,
      input.filename,
    );
    await this.storage.putStream(
      { bucket: this.storage.bucket, key: objectKey },
      input.body,
      input.mimeType ?? 'application/octet-stream',
    );

    const source = {
      kind: 'upload',
      filename: input.filename,
      objectKey,
      mimeType: input.mimeType,
      sizeBytes: input.sizeBytes,
    };
    try {
      await this.jobs.create(tenant, { id, source, settings: settings as unknown as Record<string, unknown> });
    } catch (error) {
      await this.storage.delete({ bucket: this.storage.bucket, key: objectKey }).catch(() => undefined);
      throw error;
    }
    try {
      await this.dispatch({
        jobId: id,
        organizationId: tenant.organizationId,
        workspaceId: tenant.workspaceId,
        source,
        settings: settings as unknown as Record<string, unknown>,
      });
    } catch (error) {
      await this.jobs.update(tenant, id, { stage: 'failed', error: error instanceof Error ? error.message : String(error), finishedAt: new Date().toISOString() });
      await this.storage.delete({ bucket: this.storage.bucket, key: objectKey }).catch(() => undefined);
      throw error;
    }
    return this.getClientJob(principal, id);
  }

  async createUrl(principal: Principal, url: string, settings: JobSettings): Promise<ClientJob> {
    await this.initialize(principal, 'job:create');
    const tenant = context(principal);
    const id = randomUUID();
    const source = { kind: 'url', url };
    const serializedSettings = settings as unknown as Record<string, unknown>;
    await this.jobs.create(tenant, { id, source, settings: serializedSettings });
    try {
      await this.dispatch({
        jobId: id,
        organizationId: tenant.organizationId,
        workspaceId: tenant.workspaceId,
        source,
        settings: serializedSettings,
      });
    } catch (error) {
      await this.jobs.update(tenant, id, { stage: 'failed', error: error instanceof Error ? error.message : String(error), finishedAt: new Date().toISOString() });
      throw error;
    }
    return this.getClientJob(principal, id);
  }

  async dispatch(payload: MotionJobPayload, options?: { jobId?: string }): Promise<void> {
    await this.queue.enqueue(payload, options);
  }

  async listDeadLetters(principal: Principal): Promise<Array<{
    id: string;
    label: string;
    stage: string;
    progress: number;
    attempt: number;
    maxAttempts: number;
    error?: string;
    createdAt: string;
    updatedAt: string;
    finishedAt?: string;
  }>> {
    await this.initialize(principal, 'job:operate');
    const rows = await this.workerJobs.listDeadLetters(context(principal));
    return rows.map(row => ({
      id: row.id,
      label: deadLetterLabel(row.source, row.id),
      stage: row.stage,
      progress: Number(row.progress),
      attempt: row.attempt,
      maxAttempts: row.maxAttempts,
      error: row.error,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      finishedAt: row.finishedAt,
    }));
  }

  async redrive(principal: Principal, id: string): Promise<boolean> {
    await this.initialize(principal, 'job:operate');
    const tenant = context(principal);
    const row = await this.jobs.get(tenant, id);
    if (!row) return false;
    const redriven = await this.workerJobs.redrive(tenant, id);
    if (!redriven) return false;
    try {
      await this.dispatch({
        jobId: row.id,
        organizationId: row.organizationId,
        workspaceId: row.workspaceId,
        source: row.source,
        settings: row.settings,
      }, { jobId: `${row.id}-redrive-${Date.now()}` });
    } catch (error) {
      await this.jobs.update(tenant, id, {
        stage: 'failed',
        error: `Redrive dispatch failed: ${error instanceof Error ? error.message : String(error)}`,
        finishedAt: new Date().toISOString(),
      }).catch(() => undefined);
      throw error;
    }
    return true;
  }

  async listClientJobs(principal: Principal): Promise<JobSummary[]> {
    await this.initialize(principal, 'job:read');
    const rows = await this.jobs.list(context(principal));
    return rows.map(toSummary);
  }

  async getClientJob(principal: Principal, id: string): Promise<ClientJob> {
    await this.initialize(principal, 'job:read');
    const row = await this.jobs.get(context(principal), id);
    if (!row) throw new Error('Job not found');
    return toClientJob(row);
  }

  async getClientJobOrNull(principal: Principal, id: string): Promise<ClientJob | null> {
    await this.initialize(principal, 'job:read');
    const row = await this.jobs.get(context(principal), id);
    return row ? toClientJob(row) : null;
  }

  async cancel(principal: Principal, id: string): Promise<boolean> {
    await this.initialize(principal, 'job:cancel');
    const tenant = context(principal);
    const cancelled = await this.workerJobs.cancel(tenant, id);
    if (cancelled) await this.queue.cancel(id);
    return cancelled;
  }

  async delete(principal: Principal, id: string): Promise<boolean> {
    await this.initialize(principal, 'job:delete');
    const tenant = context(principal);
    const row = await this.jobs.get(tenant, id);
    if (!row) return false;
    if (row.outputObjectKey) {
      await this.storage.delete({ bucket: this.storage.bucket, key: row.outputObjectKey }).catch(() => undefined);
    }
    const source = row.source;
    if (source.kind === 'upload' && typeof source.objectKey === 'string') {
      await this.storage.delete({ bucket: this.storage.bucket, key: source.objectKey }).catch(() => undefined);
    }
    return this.jobs.delete(tenant, id);
  }

  async signedDownload(principal: Principal, id: string): Promise<string | null> {
    await this.initialize(principal, 'job:download');
    const row = await this.jobs.get(context(principal), id);
    if (!row?.outputObjectKey) return null;
    return this.storage.signedDownload({ bucket: this.storage.bucket, key: row.outputObjectKey });
  }

  async downloadArtifact(principal: Principal, id: string): Promise<{ bytes: Uint8Array; filename: string } | null> {
    await this.initialize(principal, 'job:download');
    const row = await this.jobs.get(context(principal), id);
    if (!row?.outputObjectKey) return null;
    const filename = row.outputObjectKey.split('/').pop() ?? 'motion.bvh';
    const bytes = await this.storage.downloadBytes({ bucket: this.storage.bucket, key: row.outputObjectKey });
    return { bytes, filename };
  }

  async close(): Promise<void> {
    await this.queue.close();
    await this.database.close();
  }
}

let cached: DurablePlatform | null = null;

export function getDurablePlatform(): DurablePlatform {
  if (!cached) cached = new DurablePlatform();
  return cached;
}

export function _resetDurablePlatformForTests(): void {
  cached = null;
}

function toSummary(row: PersistedJob): JobSummary {
  return {
    id: row.id,
    organizationId: row.organizationId,
    workspaceId: row.workspaceId,
    createdBy: row.createdBy,
    createdAt: row.createdAt,
    label: sourceLabel(row),
    stage: row.stage as JobStage,
    progress: Number(row.progress),
    outputName: row.outputObjectKey?.split('/').pop(),
    error: row.error,
    finishedAt: row.finishedAt,
  };
}

function toClientJob(row: PersistedJob): ClientJob {
  const source = row.source.kind === 'upload'
    ? {
        kind: 'upload' as const,
        filename: typeof row.source.filename === 'string' ? row.source.filename : 'upload',
        sizeBytes: typeof row.source.sizeBytes === 'number' ? row.source.sizeBytes : undefined,
      }
    : { kind: 'url' as const, url: typeof row.source.url === 'string' ? row.source.url : '' };
  return {
    id: row.id,
    createdAt: row.createdAt,
    source,
    settings: row.settings as unknown as JobSettings,
    stage: row.stage as JobStage,
    progress: Number(row.progress),
    message: row.stage,
    outputName: row.outputObjectKey?.split('/').pop(),
    error: row.error,
    finishedAt: row.finishedAt,
    history: [],
    label: sourceLabel(row),
  };
}

function deadLetterLabel(source: Record<string, unknown>, id: string): string {
  if (source.kind === 'upload' && typeof source.filename === 'string') {
    return source.filename.replace(/\.[^.]+$/, '') || id;
  }
  if (typeof source.url === 'string') {
    try {
      return new URL(source.url).pathname.split('/').filter(Boolean).pop() ?? source.url;
    } catch {
      return source.url;
    }
  }
  return id;
}

function sourceLabel(row: PersistedJob): string {
  if (row.source.kind === 'upload' && typeof row.source.filename === 'string') {
    return row.source.filename.replace(/\.[^.]+$/, '') || row.id;
  }
  if (typeof row.source.url === 'string') {
    try {
      return new URL(row.source.url).pathname.split('/').filter(Boolean).pop() ?? row.source.url;
    } catch {
      return row.source.url;
    }
  }
  return row.id;
}
