import { describe, expect, it } from 'vitest';
import { ObjectStorage } from '../src/index.js';

describe('ObjectStorage', () => {
  it('creates stable tenant-scoped object keys', () => {
    const storage = new ObjectStorage({ bucket: 'mocap' });
    expect(storage.tenantKey('org-1', 'workspace-1', 'asset-1', 'dance video.mp4'))
      .toBe('organizations/org-1/workspaces/workspace-1/assets/asset-1/dance_video.mp4');
  });

  it('rejects unsafe tenant identifiers', () => {
    const storage = new ObjectStorage({ bucket: 'mocap' });
    expect(() => storage.tenantKey('../org', 'workspace-1', 'asset-1')).toThrow(/identifier/);
    expect(() => storage.tenantKey('org-1', 'workspace/1', 'asset-1')).toThrow(/identifier/);
  });
});
