import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Pool, type PoolConfig, type QueryResultRow } from 'pg';

export interface TenantContext {
  organizationId: string;
  workspaceId: string;
  principalId: string;
}

export interface DatabaseOptions extends PoolConfig {
  connectionString?: string;
}

export interface PersistedJob {
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
  createdAt: string;
  finishedAt?: string;
  error?: string;
  outputObjectKey?: string;
}

export interface CreateJobInput {
  id: string;
  source: Record<string, unknown>;
  settings: Record<string, unknown>;
  maxAttempts?: number;
}

/** PostgreSQL adapter. Set DATABASE_URL in the host service. */
export class Database {
  readonly pool: Pool;

  constructor(options: DatabaseOptions = {}) {
    this.pool = new Pool({
      connectionString: options.connectionString ?? process.env.DATABASE_URL,
      max: options.max ?? 10,
      idleTimeoutMillis: options.idleTimeoutMillis ?? 30_000,
      ...options,
    });
  }

  async health(): Promise<boolean> {
    const result = await this.pool.query('select 1 as ok');
    return result.rows[0]?.ok === 1;
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  async workspaceMembershipRole(organizationId: string, workspaceId: string, principalId: string): Promise<string | null> {
    const result = await this.pool.query<{ role: string }>(
      `select wm.role
       from workspace_memberships wm
       join workspaces w on w.id = wm.workspace_id
       where wm.workspace_id = $1 and w.organization_id = $2 and wm.principal_id = $3`,
      [workspaceId, organizationId, principalId],
    );
    return result.rows[0]?.role ?? null;
  }

  async ensureLocalTenant(context: TenantContext): Promise<void> {
    await this.pool.query(
      `insert into organizations(id, name, slug) values ($1, $2, $1)
       on conflict (id) do update set name = excluded.name`,
      [context.organizationId, context.organizationId],
    );
    await this.pool.query(
      `insert into workspaces(id, organization_id, name, slug) values ($1, $2, $1, $1)
       on conflict (id) do nothing`,
      [context.workspaceId, context.organizationId],
    );
    await this.pool.query(
      `insert into workspace_memberships(workspace_id, principal_id, role) values ($1, $2, 'owner')
       on conflict (workspace_id, principal_id) do update set role = 'owner'`,
      [context.workspaceId, context.principalId],
    );
  }

  async migrate(migrationsDir = defaultMigrationsDir()): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      await client.query(`
        create table if not exists schema_migrations (
          version text primary key,
          applied_at timestamptz not null default now()
        )
      `);
      const files = readdirSync(migrationsDir).filter(file => file.endsWith('.sql')).sort();
      for (const file of files) {
        const version = file.replace(/\.sql$/, '');
        const applied = await client.query<{ version: string }>(
          'select version from schema_migrations where version = $1',
          [version],
        );
        if (applied.rowCount) continue;
        await client.query(readFileSync(join(migrationsDir, file), 'utf8'));
        await client.query('insert into schema_migrations(version) values ($1)', [version]);
      }
      await client.query('commit');
    } catch (error) {
      await client.query('rollback');
      throw error;
    } finally {
      client.release();
    }
  }
}

/** Repository methods require tenant context for every resource query. */
export class JobRepository {
  constructor(private readonly db: Database) {}

  async create(context: TenantContext, input: CreateJobInput): Promise<void> {
    await this.db.pool.query(
      `insert into jobs
        (id, organization_id, workspace_id, created_by, source, settings, stage, progress, attempt, max_attempts)
       values ($1, $2, $3, $4, $5::jsonb, $6::jsonb, 'queued', 0, 0, $7)
       on conflict (id) do nothing`,
      [
        input.id,
        context.organizationId,
        context.workspaceId,
        context.principalId,
        JSON.stringify(input.source),
        JSON.stringify(input.settings),
        input.maxAttempts ?? 3,
      ],
    );
  }

  async get(context: TenantContext, id: string): Promise<PersistedJob | null> {
    const result = await this.db.pool.query<PersistedJob>(
      `select id, organization_id as "organizationId", workspace_id as "workspaceId",
          created_by as "createdBy", source, settings, stage, progress, attempt,
          max_attempts as "maxAttempts", created_at as "createdAt", finished_at as "finishedAt",
          error, output_object_key as "outputObjectKey"
       from jobs where id = $1 and organization_id = $2 and workspace_id = $3`,
      [id, context.organizationId, context.workspaceId],
    );
    return result.rows[0] ?? null;
  }

  async update(context: TenantContext, id: string, patch: {
    stage?: string;
    progress?: number;
    error?: string | null;
    outputObjectKey?: string | null;
    finishedAt?: string | null;
    leasedAt?: string | null;
    cancelRequested?: boolean;
  }): Promise<boolean> {
    const fields: string[] = [];
    const values: unknown[] = [];
    const add = (column: string, value: unknown) => {
      values.push(value);
      fields.push(`${column} = $${values.length}`);
    };
    if (patch.stage !== undefined) add('stage', patch.stage);
    if (patch.progress !== undefined) add('progress', patch.progress);
    if (patch.error !== undefined) add('error', patch.error);
    if (patch.outputObjectKey !== undefined) add('output_object_key', patch.outputObjectKey);
    if (patch.finishedAt !== undefined) add('finished_at', patch.finishedAt);
    if (patch.leasedAt !== undefined) add('leased_at', patch.leasedAt);
    if (patch.cancelRequested !== undefined) add('cancel_requested', patch.cancelRequested);
    if (fields.length === 0) return false;
    values.push(id, context.organizationId, context.workspaceId);
    const result = await this.db.pool.query(
      `update jobs set ${fields.join(', ')}, updated_at = now()
       where id = $${values.length - 2} and organization_id = $${values.length - 1}
         and workspace_id = $${values.length}`,
      values,
    );
    return result.rowCount === 1;
  }

  async delete(context: TenantContext, id: string): Promise<boolean> {
    const result = await this.db.pool.query(
      `delete from jobs where id = $1 and organization_id = $2 and workspace_id = $3`,
      [id, context.organizationId, context.workspaceId],
    );
    return result.rowCount === 1;
  }

  async list(context: TenantContext, limit = 100): Promise<PersistedJob[]> {
    const result = await this.db.pool.query<PersistedJob>(
      `select id, organization_id as "organizationId", workspace_id as "workspaceId",
          created_by as "createdBy", source, settings, stage, progress, attempt,
          max_attempts as "maxAttempts", created_at as "createdAt", finished_at as "finishedAt",
          error, output_object_key as "outputObjectKey"
       from jobs where organization_id = $1 and workspace_id = $2
       order by created_at desc limit $3`,
      [context.organizationId, context.workspaceId, Math.min(Math.max(limit, 1), 1000)],
    );
    return result.rows;
  }
}

export {
  WorkerJobRepository,
  type ClaimedJob,
  type RecoveredJob,
  type QueuedJob,
  type DeadLetterJob,
} from './worker-repository.js';
export { UploadSessionRepository, type UploadSession, type UploadSessionStatus, type CreateUploadSessionInput } from './upload-repository.js';

function defaultMigrationsDir(): string {
  // Works from the repository, a package build, and the production container.
  const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  return join(packageRoot, 'migrations');
}

export function createDatabase(options: DatabaseOptions = {}): Database {
  return new Database(options);
}

export function isQueryResultRow(value: unknown): value is QueryResultRow {
  return typeof value === 'object' && value !== null;
}
