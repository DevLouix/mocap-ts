import { describe, expect, it, vi } from 'vitest';
import { Database, JobRepository, WorkerJobRepository } from '../src/index.js';

describe('JobRepository', () => {
  it('resolves membership through both workspace and organization', async () => {
    const db = new Database({ connectionString: 'postgres://unused' });
    const query = vi.spyOn(db.pool, 'query').mockResolvedValue({ rows: [{ role: 'editor' }], rowCount: 1 } as never);
    await expect(db.workspaceMembershipRole('org-1', 'workspace-1', 'user-1')).resolves.toBe('editor');
    expect(query.mock.calls[0]?.[1]).toEqual(['workspace-1', 'org-1', 'user-1']);
    await db.close();
  });

  it('requires tenant context in every resource query', async () => {
    const db = new Database({ connectionString: 'postgres://unused' });
    const query = vi.spyOn(db.pool, 'query').mockResolvedValue({ rows: [], rowCount: 0 } as never);
    const repo = new JobRepository(db);
    await repo.get({ organizationId: 'org-1', workspaceId: 'workspace-1', principalId: 'user-1' }, 'job-1');
    expect(query.mock.calls[0]?.[1]).toEqual(['job-1', 'org-1', 'workspace-1']);
    await db.close();
  });

  it('claims with a database-independent lease token and fences heartbeat updates', async () => {
    const db = new Database({ connectionString: 'postgres://unused' });
    const query = vi.spyOn(db.pool, 'query')
      .mockResolvedValueOnce({ rows: [{ id: 'job-1', leaseToken: 'lease-1' }], rowCount: 1 } as never)
      .mockResolvedValueOnce({ rows: [], rowCount: 1 } as never);
    const repo = new WorkerJobRepository(db.pool);
    const claimed = await repo.claim('job-1', 60);
    expect(claimed?.leaseToken).toBe('lease-1');
    await repo.heartbeat({ organizationId: 'org-1', workspaceId: 'workspace-1', principalId: 'worker' }, 'job-1', 'lease-1', 60);
    expect(query.mock.calls[0]?.[1]).toHaveLength(3);
    expect(query.mock.calls[1]?.[1]).toEqual(['job-1', 'org-1', 'workspace-1', '60', 'lease-1']);
    await db.close();
  });

  it('returns only database-selected expired jobs for recovery', async () => {
    const db = new Database({ connectionString: 'postgres://unused' });
    const query = vi.spyOn(db.pool, 'query').mockResolvedValue({
      rows: [{ id: 'job-1', organizationId: 'org-1', workspaceId: 'workspace-1', stage: 'queued', attempt: 1, maxAttempts: 3, cancelRequested: false }],
      rowCount: 1,
    } as never);
    const recovered = await new WorkerJobRepository(db.pool).recoverExpired(25);
    expect(recovered[0]?.stage).toBe('queued');
    expect(query.mock.calls[0]?.[1]).toEqual([25]);
  });

  it('scopes dead-letter inspection and redrive to the active workspace', async () => {
    const db = new Database({ connectionString: 'postgres://unused' });
    const query = vi.spyOn(db.pool, 'query')
      .mockResolvedValueOnce({ rows: [], rowCount: 0 } as never)
      .mockResolvedValueOnce({ rows: [], rowCount: 1 } as never);
    const context = { organizationId: 'org-1', workspaceId: 'workspace-1', principalId: 'admin' };
    const repo = new WorkerJobRepository(db.pool);
    await repo.listDeadLetters(context, 10);
    await repo.redrive(context, 'job-1');
    expect(query.mock.calls[0]?.[1]).toEqual(['org-1', 'workspace-1', 10]);
    expect(query.mock.calls[1]?.[1]).toEqual(['job-1', 'org-1', 'workspace-1']);
  });
});
