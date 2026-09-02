import { describe, expect, it } from 'vitest';
import {
  canReviewWorkspace,
  canWriteWorkspace,
  hasWorkspaceRole,
  type Principal,
} from '../src/identity/index.js';
import {
  isPrivateAddress,
  parseRemoteVideoUrl,
  validateRemoteVideoUrl,
} from '../src/video/url-policy.js';
import { hasSupportedVideoSignature } from '../src/video/file-policy.js';

const editor: Principal = {
  id: 'user-1',
  provider: 'local',
  organizationId: 'org-1',
  workspaceId: 'workspace-1',
  roles: ['editor'],
};

describe('workspace authorization contracts', () => {
  it('recognizes role-based write and review permissions', () => {
    expect(hasWorkspaceRole(editor, 'editor')).toBe(true);
    expect(canWriteWorkspace(editor)).toBe(true);
    expect(canReviewWorkspace(editor)).toBe(true);
    expect(hasWorkspaceRole({ ...editor, roles: ['viewer'] }, 'editor')).toBe(false);
  });
});

describe('uploaded video file policy', () => {
  it('requires a known container signature, not only an extension', () => {
    expect(hasSupportedVideoSignature('clip.mp4', new TextEncoder().encode('not video'))).toBe(false);
    expect(hasSupportedVideoSignature('clip.mp4', new Uint8Array([0, 0, 0, 0, 0, 0, 0, 0]))).toBe(false);
    expect(hasSupportedVideoSignature('clip.mp4', new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112]))).toBe(true);
    expect(hasSupportedVideoSignature('clip.webm', new Uint8Array([0x1a, 0x45, 0xdf, 0xa3]))).toBe(true);
  });
});

describe('remote video URL policy', () => {
  it('rejects credentials and non-standard ports before DNS', () => {
    expect(() => parseRemoteVideoUrl('https://user:pass@youtube.com/watch?v=x')).toThrow(/credentials/);
    expect(() => parseRemoteVideoUrl('https://youtube.com:8080/watch?v=x')).toThrow(/standard/);
    expect(() => parseRemoteVideoUrl('file:///etc/passwd')).toThrow(/HTTP/);
  });

  it('rejects private and reserved addresses', () => {
    for (const address of ['10.0.0.1', '127.0.0.1', '169.254.169.254', '192.168.1.10', '::1']) {
      expect(isPrivateAddress(address)).toBe(true);
    }
  });

  it('requires an approved host even when the syntax is valid', async () => {
    await expect(
      validateRemoteVideoUrl('https://not-approved.example/video.mp4', {
        resolveDns: false,
      }),
    ).rejects.toThrow(/Unsupported video host/);
  });

  it('supports explicitly configured public hosts without allowing private addresses', async () => {
    await expect(
      validateRemoteVideoUrl('https://media.example/video.mp4', {
        allowedHosts: ['example'],
        resolveDns: false,
      }),
    ).resolves.toBeInstanceOf(URL);

    await expect(
      validateRemoteVideoUrl('https://127.0.0.1/video.mp4', {
        allowedHosts: ['127.0.0.1'],
        resolveDns: false,
      }),
    ).rejects.toThrow(/private or reserved/);
  });
});
