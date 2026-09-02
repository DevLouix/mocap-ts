import { describe, expect, it, vi } from 'vitest';
import { UploadSessionRepository } from '../src/upload-repository.js';
import { Database } from '../src/index.js';

const context = { organizationId: 'org-1', workspaceId: 'workspace-1', principalId: 'user-1' };

describe('UploadSessionRepository', () => {
  it('scopes session reads to the organization and workspace', async () => {
    const db = new Database({ connectionString: 'postgres://unused' });
    const query = vi.spyOn(db.pool, 'query').mockResolvedValue({ rows: [], rowCount: 0 } as never);
    await new UploadSessionRepository(db.pool).get(context, 'session-1');
    expect(query.mock.calls[0]?.[1]).toEqual(['session-1', 'org-1', 'workspace-1']);
    await db.close();
  });

  it('persists the multipart provider id and declared object metadata', async () => {
    const db = new Database({ connectionString: 'postgres://unused' });
    const query = vi.spyOn(db.pool, 'query').mockResolvedValue({ rows: [], rowCount: 1 } as never);
    await new UploadSessionRepository(db.pool).create(context, {
      id: 'session-1',
      bucket: 'mocap',
      objectKey: 'organizations/org-1/workspaces/workspace-1/assets/session-1/video.mp4',
      providerUploadId: 'provider-upload-1',
      filename: 'video.mp4',
      mimeType: 'video/mp4',
      sizeBytes: 10,
      partSize: 8,
      partCount: 2,
      settings: { hands: false, smoothing: 0.7 },
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    expect(query.mock.calls[0]?.[1]).toContain('provider-upload-1');
    expect(query.mock.calls[0]?.[1]).toContain(10);
    await db.close();
  });
});
