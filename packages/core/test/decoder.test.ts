import { describe, it, expect } from 'vitest';
import { loadFrameDir, isYouTubeUrl, isVideoUrl } from '../src/video/decoder.js';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('decoder', () => {
  it('loadFrameDir sorts and filters correctly', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mocap-test-'));
    writeFileSync(join(dir, 'frame_000001.png'), '');
    writeFileSync(join(dir, 'frame_000003.png'), '');
    writeFileSync(join(dir, 'frame_000002.png'), '');
    writeFileSync(join(dir, 'frame_000004.jpg'), '');
    writeFileSync(join(dir, 'readme.txt'), '');

    const frames = loadFrameDir(dir);
    expect(frames).toHaveLength(4);
    expect(frames[0]).toContain('frame_000001.png');
    expect(frames[1]).toContain('frame_000002.png');
    expect(frames[2]).toContain('frame_000003.png');
    expect(frames[3]).toContain('frame_000004.jpg');
  });

  it('loadFrameDir returns empty for empty directory', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mocap-empty-'));
    expect(loadFrameDir(dir)).toEqual([]);
  });
});

describe('URL detection', () => {
  it('detects YouTube watch URLs', () => {
    expect(isYouTubeUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ')).toBe(true);
    expect(isYouTubeUrl('https://youtube.com/watch?v=dQw4w9WgXcQ')).toBe(true);
    expect(isYouTubeUrl('http://www.youtube.com/watch?v=abc123')).toBe(true);
  });

  it('detects YouTube shorts', () => {
    expect(isYouTubeUrl('https://www.youtube.com/shorts/abc123')).toBe(true);
  });

  it('detects youtu.be short links', () => {
    expect(isYouTubeUrl('https://youtu.be/dQw4w9WgXcQ')).toBe(true);
  });

  it('detects YouTube embed and live URLs', () => {
    expect(isYouTubeUrl('https://www.youtube.com/embed/abc123')).toBe(true);
    expect(isYouTubeUrl('https://www.youtube.com/live/abc123')).toBe(true);
  });

  it('rejects non-YouTube URLs', () => {
    expect(isYouTubeUrl('https://vimeo.com/12345')).toBe(false);
    expect(isYouTubeUrl('https://example.com/video.mp4')).toBe(false);
    expect(isYouTubeUrl('/path/to/file.mp4')).toBe(false);
  });

  it('isVideoUrl detects any http(s) URL', () => {
    expect(isVideoUrl('https://example.com/dance.mp4')).toBe(true);
    expect(isVideoUrl('http://vimeo.com/12345')).toBe(true);
    expect(isVideoUrl('https://www.youtube.com/watch?v=abc')).toBe(true);
  });

  it('isVideoUrl rejects non-URLs', () => {
    expect(isVideoUrl('/path/to/file.mp4')).toBe(false);
    expect(isVideoUrl('./video.mp4')).toBe(false);
    expect(isVideoUrl('video.mp4')).toBe(false);
    expect(isVideoUrl('')).toBe(false);
  });
});
