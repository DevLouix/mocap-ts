import { describe, expect, it, vi } from 'vitest';
import { ObjectStorage } from '../src/index.js';

describe('ObjectStorage multipart operations', () => {
  it('reads all pages from ListParts', async () => {
    const storage = new ObjectStorage({ bucket: 'mocap' });
    const send = vi.spyOn(storage.client, 'send')
      .mockResolvedValueOnce({
        IsTruncated: true,
        NextPartNumberMarker: '1000',
        Parts: [{ PartNumber: 1, ETag: 'etag-1', Size: 8 }],
      } as never)
      .mockResolvedValueOnce({
        IsTruncated: false,
        Parts: [{ PartNumber: 2, ETag: 'etag-2', Size: 2 }],
      } as never);

    const parts = await storage.listParts({
      uploadId: 'upload-1',
      address: { bucket: 'mocap', key: 'safe/video.mp4' },
    });

    expect(parts).toEqual([
      { partNumber: 1, etag: 'etag-1', checksumSha256: undefined, sizeBytes: 8 },
      { partNumber: 2, etag: 'etag-2', checksumSha256: undefined, sizeBytes: 2 },
    ]);
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[1]?.[0]).toMatchObject({ input: { PartNumberMarker: '1000' } });
  });
});
