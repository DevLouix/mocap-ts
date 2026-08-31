import { describe, it, expect } from 'vitest';
import { writeBVH, parseBVHMeta } from '../src/export/bvh.js';
import { createSkeleton } from '../src/skeleton/hierarchy.js';
import { solveIK } from '../src/skeleton/ik.js';
import { IDENTITY } from '../src/math/quaternion.js';
import type { IKFrame } from '../src/skeleton/ik.js';
import type { Landmark, FramePose } from '../src/pose/types.js';

const skeleton = createSkeleton();

function makeLandmark(x: number, y: number, z: number, vis: number = 1): Landmark {
  return { x, y, z, visibility: vis };
}

function tposeFrame(): FramePose {
  const body: Landmark[] = new Array(33).fill(null).map(() =>
    makeLandmark(0.5, 0.5, 0, 0.9)
  );
  body[0] = makeLandmark(0.5, 0.15, 0, 1);
  // MediaPipe: subject's left = image right (higher x)
  body[11] = makeLandmark(0.65, 0.3, 0, 1); // left shoulder
  body[12] = makeLandmark(0.35, 0.3, 0, 1); // right shoulder
  body[13] = makeLandmark(0.8, 0.3, 0, 1);  // left elbow
  body[14] = makeLandmark(0.2, 0.3, 0, 1);  // right elbow
  body[15] = makeLandmark(0.95, 0.3, 0, 1); // left wrist
  body[16] = makeLandmark(0.05, 0.3, 0, 1); // right wrist
  body[23] = makeLandmark(0.55, 0.55, 0, 1); // left hip
  body[24] = makeLandmark(0.45, 0.55, 0, 1); // right hip
  body[25] = makeLandmark(0.55, 0.75, 0, 1); // left knee
  body[26] = makeLandmark(0.45, 0.75, 0, 1); // right knee
  body[27] = makeLandmark(0.55, 0.95, 0, 1); // left ankle
  body[28] = makeLandmark(0.45, 0.95, 0, 1); // right ankle
  return { body, frameIndex: 0 };
}

function makeIdentityFrame(): IKFrame {
  return {
    rootPosition: { x: 0, y: 0, z: 0 },
    localRotations: skeleton.joints.map(() => IDENTITY),
  };
}

describe('BVH export', () => {
  it('generates valid BVH with correct structure', () => {
    const frames = [makeIdentityFrame()];
    const bvh = writeBVH(skeleton, frames, 30);

    expect(bvh).toContain('HIERARCHY');
    expect(bvh).toContain('ROOT Hips');
    expect(bvh).toContain('MOTION');
    expect(bvh).toContain('Frames: 1');
    expect(bvh).toContain('Frame Time: 0.033333');
  });

  it('contains all skeleton joints', () => {
    const bvh = writeBVH(skeleton, [makeIdentityFrame()], 30);
    for (const joint of skeleton.joints) {
      expect(bvh).toContain(joint.name);
    }
  });

  it('parseBVHMeta extracts correct counts', () => {
    const frames = [makeIdentityFrame(), makeIdentityFrame(), makeIdentityFrame()];
    const bvh = writeBVH(skeleton, frames, 60);
    const meta = parseBVHMeta(bvh);

    expect(meta.jointCount).toBe(skeleton.joints.length);
    expect(meta.frameCount).toBe(3);
    expect(meta.frameTime).toBeCloseTo(1 / 60, 5);
    // Root has 6 channels, others have 3 each
    const expectedChannels = 6 + (skeleton.joints.length - 1) * 3;
    expect(meta.channelCount).toBe(expectedChannels);
  });

  it('motion data has correct number of values per line', () => {
    const bvh = writeBVH(skeleton, [makeIdentityFrame()], 30);
    const lines = bvh.split('\n');

    // Find the first motion data line (after "Frame Time:" line)
    const frameTimeIdx = lines.findIndex(l => l.startsWith('Frame Time:'));
    const dataLine = lines[frameTimeIdx + 1];
    const values = dataLine.trim().split(/\s+/);

    // Expected: 6 (root) + 19 * 3 (others) = 63
    const expectedChannels = 6 + (skeleton.joints.length - 1) * 3;
    expect(values.length).toBe(expectedChannels);
  });

  it('identity rotations produce near-zero Euler angles', () => {
    const bvh = writeBVH(skeleton, [makeIdentityFrame()], 30);
    const lines = bvh.split('\n');
    const frameTimeIdx = lines.findIndex(l => l.startsWith('Frame Time:'));
    const dataLine = lines[frameTimeIdx + 1];
    const values = dataLine.trim().split(/\s+/).map(Number);

    // Skip first 3 (root position), check rotation values
    for (let i = 3; i < values.length; i++) {
      expect(Math.abs(values[i])).toBeLessThan(0.01);
    }
  });

  it('roundtrip: IK solve → BVH → parse metadata', () => {
    const frame = tposeFrame();
    const ikResult = solveIK(frame, skeleton);
    const bvh = writeBVH(skeleton, [ikResult], 30);
    const meta = parseBVHMeta(bvh);

    expect(meta.jointCount).toBe(20);
    expect(meta.frameCount).toBe(1);
  });

  it('multi-frame BVH has correct motion lines', () => {
    const f1 = makeIdentityFrame();
    const f2 = makeIdentityFrame();
    f2.rootPosition = { x: 10, y: 0, z: 5 };

    const bvh = writeBVH(skeleton, [f1, f2], 30);
    const meta = parseBVHMeta(bvh);
    expect(meta.frameCount).toBe(2);

    // Second frame should show different root position
    const lines = bvh.split('\n');
    const frameTimeIdx = lines.findIndex(l => l.startsWith('Frame Time:'));
    const line2 = lines[frameTimeIdx + 2];
    const vals = line2.trim().split(/\s+/).map(Number);
    expect(vals[0]).toBeCloseTo(10, 3); // X position
    expect(vals[2]).toBeCloseTo(5, 3);  // Z position
  });

  it('leaf joints have End Site markers', () => {
    const bvh = writeBVH(skeleton, [makeIdentityFrame()], 30);
    expect(bvh).toContain('End Site');
  });

  it('HIERARCHY uses correct indentation', () => {
    const bvh = writeBVH(skeleton, [makeIdentityFrame()], 30);
    // ROOT should not be indented
    expect(bvh).toMatch(/^ROOT Hips$/m);
    // First-level joints should be indented by 2 spaces (inside ROOT's braces)
    expect(bvh).toMatch(/^  JOINT Spine$/m);
  });
});
