import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type { TenantContext } from './index.js';

export interface ClaimedJob {
  id: string;
  organizationId: string;
  workspaceId: string;
  createdBy: string;
  source: Record<string, unknown>;
  settings: Record<string, unknown>;
  attempt: number;
  maxAttempts: number;
  leaseToken: string;
}

export interface RecoveredJob {
  id: string;
  organizationId: string;
  workspaceId: string;
  createdBy: string;
  source: Record<string, unknown>;
  settings: Record<string, unknown>;
  stage: 'queued' | 'failed' | 'cancelled';
  attempt: number;
  maxAttempts: number;
  cancelRequested: boolean;
}

export interface QueuedJob {
  id: string;
  organizationId: string;
  workspaceId: string;
  source: Record<string, unknown>;
  settings: Record<string, unknown>;
  attempt: number;
}

export interface DeadLetterJob {
  id: string;
  organizationId: string;
  workspaceId: string;
  createdBy: string;
  source: Record<string, unknown>;
  settings: Record<string, unknown>;
  stage: string;
  progress: number;
  attempt: number;
  maxAttempts: number;
  error?: string;
  createdAt: string;
  updatedAt: string;
  finishedAt?: string;
}

/**
 * Worker-only repository methods. Claims are atomic at the database layer so
 * multiple worker hosts cannot process the same queued row. Every running
 * attempt is fenced by a lease token so a stale worker cannot update a job
 * after a reaper has returned it to the queue.
 */
export class WorkerJobRepository {
  constructor(private readonly pool: Pool) {}

  async claim(id: string, leaseSeconds = 300): Promise<ClaimedJob | null> {
    const result = await this.pool.query<ClaimedJob>(
      `update jobs
       set stage = 'running', attempt = attempt + 1, lease_token = $3,
           leased_at = now() + ($2::text || ' seconds')::interval, updated_at = now()
       where id = $1 and stage = 'queued' and cancel_requested = false
       returning id, organization_id as "organizationId", workspace_id as "workspaceId",
         created_by as "createdBy", source, settings, attempt, max_attempts as "maxAttempts",
         lease_token as "leaseToken"`,
      [id, String(Math.min(Math.max(leaseSeconds, 30), 86_400)), randomUUID()],
    );
    return result.rows[0] ?? null;
  }

  async update(context: TenantContext, id: string, patch: { stage?: string; progress?: number; error?: string | null }, leaseToken?: string): Promise<boolean> {
    const fields: string[] = [];
    const values: unknown[] = [];
    const add = (column: string, value: unknown) => {
      values.push(value);
      fields.push(`${column} = $${values.length}`);
    };
    if (patch.stage !== undefined) add('stage', patch.stage);
    if (patch.progress !== undefined) add('progress', Math.min(Math.max(patch.progress, 0), 1));
    if (patch.error !== undefined) add('error', patch.error);
    if (fields.length === 0) return false;
    const idParam = values.length + 1;
    const organizationParam = values.length + 2;
    const workspaceParam = values.length + 3;
    values.push(id, context.organizationId, context.workspaceId);
    const tokenClause = leaseToken ? ` and lease_token = $${values.length + 1}` : '';
    if (leaseToken) values.push(leaseToken);
    const result = await this.pool.query(
      `update jobs set ${fields.join(', ')}, updated_at = now()
       where id = $${idParam} and organization_id = $${organizationParam}
         and workspace_id = $${workspaceParam}
         and stage not in ('done', 'failed', 'cancelled')${tokenClause}`,
      values,
    );
    return result.rowCount === 1;
  }

  async heartbeat(context: TenantContext, id: string, leaseToken: string, leaseSeconds = 300): Promise<boolean> {
    const result = await this.pool.query(
      `update jobs set leased_at = now() + ($4::text || ' seconds')::interval, updated_at = now()
       where id = $1 and organization_id = $2 and workspace_id = $3 and stage = 'running'
         and cancel_requested = false and lease_token = $5`,
      [id, context.organizationId, context.workspaceId, String(Math.min(Math.max(leaseSeconds, 30), 86_400)), leaseToken],
    );
    return result.rowCount === 1;
  }

  async cancellationRequested(context: TenantContext, id: string, leaseToken?: string): Promise<boolean> {
    const tokenClause = leaseToken ? ' and lease_token = $4' : '';
    const values = [id, context.organizationId, context.workspaceId, ...(leaseToken ? [leaseToken] : [])];
    const result = await this.pool.query<{ cancel_requested: boolean; stage: string }>(
      `select cancel_requested, stage from jobs
       where id = $1 and organization_id = $2 and workspace_id = $3${tokenClause}`,
      values,
    );
    return result.rows[0]?.cancel_requested === true || result.rows[0]?.stage === 'cancelled';
  }

  async cancel(context: TenantContext, id: string): Promise<boolean> {
    const result = await this.pool.query(
      `update jobs
       set cancel_requested = true,
           stage = case when stage in ('queued', 'running') then 'cancelled' else stage end,
           lease_token = null,
           finished_at = case when stage in ('queued', 'running') then now() else finished_at end,
           updated_at = now()
       where id = $1 and organization_id = $2 and workspace_id = $3
         and stage not in ('done', 'failed', 'cancelled')`,
      [id, context.organizationId, context.workspaceId],
    );
    return result.rowCount === 1;
  }

  async finish(context: TenantContext, id: string, outputObjectKey: string, leaseToken?: string): Promise<boolean> {
    const tokenClause = leaseToken ? ' and lease_token = $5' : '';
    const values = [id, context.organizationId, context.workspaceId, outputObjectKey, ...(leaseToken ? [leaseToken] : [])];
    const result = await this.pool.query(
      `update jobs set stage = 'done', progress = 1, output_object_key = $4,
          leased_at = null, lease_token = null, finished_at = now(), updated_at = now()
       where id = $1 and organization_id = $2 and workspace_id = $3
         and stage = 'running' and cancel_requested = false${tokenClause}`,
      values,
    );
    return result.rowCount === 1;
  }

  async fail(context: TenantContext, id: string, error: string, leaseToken?: string): Promise<'retry' | 'failed' | 'cancelled' | 'stale' | 'missing'> {
    const tokenClause = leaseToken ? ' and lease_token = $4' : '';
    const selectValues = [id, context.organizationId, context.workspaceId, ...(leaseToken ? [leaseToken] : [])];
    const result = await this.pool.query<{ stage: string; attempt: number; max_attempts: number; cancel_requested: boolean }>(
      `select stage, attempt, max_attempts, cancel_requested from jobs
       where id = $1 and organization_id = $2 and workspace_id = $3${tokenClause} for update`,
      selectValues,
    );
    const row = result.rows[0];
    if (!row) return leaseToken ? 'stale' : 'missing';
    if (row.cancel_requested || row.stage === 'cancelled') return 'cancelled';
    if (row.attempt < row.max_attempts) {
      await this.pool.query(
        `update jobs set stage = 'queued', error = $4, leased_at = null, lease_token = null, updated_at = now()
         where id = $1 and organization_id = $2 and workspace_id = $3`,
        [id, context.organizationId, context.workspaceId, `Attempt ${row.attempt} failed: ${error}`],
      );
      return 'retry';
    }
    await this.pool.query(
      `update jobs set stage = 'failed', error = $4, leased_at = null, lease_token = null, finished_at = now(), updated_at = now()
       where id = $1 and organization_id = $2 and workspace_id = $3`,
      [id, context.organizationId, context.workspaceId, error],
    );
    return 'failed';
  }

  /** Requeue expired running attempts, or terminally fail exhausted attempts. */
  async recoverExpired(limit = 100): Promise<RecoveredJob[]> {
    const result = await this.pool.query<RecoveredJob>(
      `with expired as (
         select id
         from jobs
         where stage = 'running' and leased_at is not null and leased_at < now()
         order by leased_at
         for update skip locked
         limit $1
       )
       update jobs j
       set stage = case
         when j.cancel_requested then 'cancelled'
         when j.attempt >= j.max_attempts then 'failed'
         else 'queued'
       end,
           error = case
             when j.cancel_requested then 'Cancelled while worker lease expired'
             when j.attempt >= j.max_attempts then coalesce(j.error, 'Worker lease expired after maximum attempts')
             else 'Worker lease expired; queued for retry'
           end,
           leased_at = null,
           lease_token = null,
           finished_at = case when j.cancel_requested or j.attempt >= j.max_attempts then now() else null end,
           updated_at = now()
       from expired
       where j.id = expired.id
       returning j.id, j.organization_id as "organizationId", j.workspace_id as "workspaceId",
         j.created_by as "createdBy", j.source, j.settings, j.stage,
         j.attempt, j.max_attempts as "maxAttempts",
         j.cancel_requested as "cancelRequested"
       `,
      [Math.min(Math.max(limit, 1), 1000)],
    );
    return result.rows;
  }

  async listQueued(limit = 100): Promise<QueuedJob[]> {
    const result = await this.pool.query<QueuedJob>(
      `select id, organization_id as "organizationId", workspace_id as "workspaceId",
          source, settings, attempt
       from jobs
       where stage = 'queued' and cancel_requested = false
       order by updated_at asc
       limit $1`,
      [Math.min(Math.max(limit, 1), 1000)],
    );
    return result.rows;
  }

  /** Record a broker failure without losing the queued database row. */
  async recordDispatchFailure(context: TenantContext, id: string, error: string): Promise<boolean> {
    const result = await this.pool.query(
      `update jobs
       set error = $4, updated_at = now()
       where id = $1 and organization_id = $2 and workspace_id = $3
         and stage = 'queued'`,
      [id, context.organizationId, context.workspaceId, `Queue dispatch failed: ${error}`],
    );
    return result.rowCount === 1;
  }

  async listDeadLetters(context: TenantContext, limit = 100): Promise<DeadLetterJob[]> {
    const result = await this.pool.query<DeadLetterJob>(
      `select id, organization_id as "organizationId", workspace_id as "workspaceId",
          created_by as "createdBy", source, settings, stage, progress, attempt,
          max_attempts as "maxAttempts", error, created_at as "createdAt",
          updated_at as "updatedAt", finished_at as "finishedAt"
       from jobs
       where organization_id = $1 and workspace_id = $2 and stage = 'failed'
         and attempt >= max_attempts
       order by finished_at desc nulls last, updated_at desc
       limit $3`,
      [context.organizationId, context.workspaceId, Math.min(Math.max(limit, 1), 1000)],
    );
    return result.rows;
  }

  /** Reset one dead-letter job for a deliberate operator retry. */
  async redrive(context: TenantContext, id: string): Promise<boolean> {
    const result = await this.pool.query(
      `update jobs
       set stage = 'queued', progress = 0, error = null, attempt = 0,
           leased_at = null, lease_token = null, finished_at = null, updated_at = now()
       where id = $1 and organization_id = $2 and workspace_id = $3
         and stage = 'failed' and attempt >= max_attempts`,
      [id, context.organizationId, context.workspaceId],
    );
    return result.rowCount === 1;
  }
}
