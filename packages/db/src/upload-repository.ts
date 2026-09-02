import type { Pool } from 'pg';
import type { TenantContext } from './index.js';

export type UploadSessionStatus = 'active' | 'completed' | 'aborted' | 'expired';

export interface UploadSession {
  id: string;
  organizationId: string;
  workspaceId: string;
  principalId: string;
  bucket: string;
  objectKey: string;
  providerUploadId: string;
  filename: string;
  mimeType?: string;
  sizeBytes: number;
  partSize: number;
  partCount: number;
  settings: Record<string, unknown>;
  status: UploadSessionStatus;
  parts: Array<{ partNumber: number; etag?: string; checksumSha256?: string; sizeBytes?: number }>;
  createdAt: string;
  expiresAt: string;
  completedAt?: string;
  jobId?: string;
}

export interface CreateUploadSessionInput {
  id: string;
  bucket: string;
  objectKey: string;
  providerUploadId: string;
  filename: string;
  mimeType?: string;
  sizeBytes: number;
  partSize: number;
  partCount: number;
  settings: Record<string, unknown>;
  expiresAt: string;
}

export class UploadSessionRepository {
  constructor(private readonly pool: Pool) {}

  async create(context: TenantContext, input: CreateUploadSessionInput): Promise<void> {
    await this.pool.query(
      `insert into upload_sessions
        (id, organization_id, workspace_id, principal_id, bucket, object_key,
         provider_upload_id, filename, mime_type, size_bytes, part_size, part_count,
         settings, expires_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb, $14)`,
      [
        input.id,
        context.organizationId,
        context.workspaceId,
        context.principalId,
        input.bucket,
        input.objectKey,
        input.providerUploadId,
        input.filename,
        input.mimeType ?? null,
        input.sizeBytes,
        input.partSize,
        input.partCount,
        JSON.stringify(input.settings),
        input.expiresAt,
      ],
    );
  }

  async get(context: TenantContext, id: string): Promise<UploadSession | null> {
    const result = await this.pool.query<UploadSession>(
      `select id, organization_id as "organizationId", workspace_id as "workspaceId",
          principal_id as "principalId", bucket, object_key as "objectKey",
          provider_upload_id as "providerUploadId", filename, mime_type as "mimeType",
          size_bytes as "sizeBytes", part_size as "partSize", part_count as "partCount",
          settings, status, parts, created_at as "createdAt", expires_at as "expiresAt",
          completed_at as "completedAt", job_id as "jobId"
       from upload_sessions
       where id = $1 and organization_id = $2 and workspace_id = $3`,
      [id, context.organizationId, context.workspaceId],
    );
    const row = result.rows[0];
    if (!row) return null;
    return {
      ...row,
      sizeBytes: Number(row.sizeBytes),
      partSize: Number(row.partSize),
      partCount: Number(row.partCount),
      parts: Array.isArray(row.parts) ? row.parts : [],
    };
  }

  async complete(
    context: TenantContext,
    id: string,
    jobId: string,
    parts: Array<{ partNumber: number; etag?: string; checksumSha256?: string; sizeBytes?: number }>,
  ): Promise<boolean> {
    const result = await this.pool.query(
      `update upload_sessions
       set status = 'completed', parts = $4::jsonb, job_id = $5, completed_at = now()
       where id = $1 and organization_id = $2 and workspace_id = $3
         and status = 'active' and expires_at > now()`,
      [id, context.organizationId, context.workspaceId, JSON.stringify(parts), jobId],
    );
    return result.rowCount === 1;
  }

  async markExpired(context: TenantContext, id: string): Promise<boolean> {
    return this.abort(context, id, 'expired');
  }

  async abort(context: TenantContext, id: string, status: 'aborted' | 'expired' = 'aborted'): Promise<boolean> {
    const result = await this.pool.query(
      `update upload_sessions set status = $4
       where id = $1 and organization_id = $2 and workspace_id = $3 and status = 'active'`,
      [id, context.organizationId, context.workspaceId, status],
    );
    return result.rowCount === 1;
  }
}
