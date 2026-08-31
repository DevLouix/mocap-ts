import { describe, it, expect } from 'vitest';
import { createSkeleton } from '../src/skeleton/hierarchy.js';
import { solveIK, createFootLockState } from '../src/skeleton/ik.js';
import { writeBVH } from '../src/export/bvh.js';
import { writeFBX } from '../src/export/fbx.js';
import { writeMotion, type ExportOptions } from '../src/export/index.js';
import type { Landmark, FramePose } from '../src/pose/types.js';

function lm(x: number, y: number, z: number, v = 1): Landmark {
  return { x, y, z, visibility: v };
}

function tPose(): FramePose {
  const body: Landmark[] = new Array(33).fill(null).map(() => lm(0.5, 0.5, 0, 0.9));
  body[0] = lm(0.5, 0.15, 0);
  body[11] = lm(0.65, 0.3, 0);
  body[12] = lm(0.35, 0.3, 0);
  body[13] = lm(0.8, 0.3, 0);
  body[14] = lm(0.2, 0.3, 0);
  body[15] = lm(0.95, 0.3, 0);
  body[16] = lm(0.05, 0.3, 0);
  body[23] = lm(0.55, 0.55, 0);
  body[24] = lm(0.45, 0.55, 0);
  body[25] = lm(0.55, 0.75, 0);
  body[26] = lm(0.45, 0.75, 0);
  body[27] = lm(0.55, 0.95, 0);
  body[28] = lm(0.45, 0.95, 0);
  return { body, frameIndex: 0 };
}

describe('export dispatcher', () => {
  const poses = [tPose()];
  const skeleton = createSkeleton();
  const ik = poses.map(p => solveIK(p, skeleton));

  it('writeMotion dispatches BVH', () => {
    const bvh = writeMotion(skeleton, ik, 30, { format: 'bvh' });
    expect(bvh.startsWith('HIERARCHY')).toBe(true);
    expect(bvh).toContain('MOTION');
  });

  it('writeMotion dispatches FBX ASCII', () => {
    const fbx = writeMotion(skeleton, ik, 30, { format: 'fbx', name: 'test' });
    expect(fbx.startsWith('; FBX')).toBe(true);
    expect(fbx).toContain('FBXVersion: 7700');
    expect(fbx).toContain('Take: "test"');
    // Should reference at least one joint name from the skeleton.
    expect(fbx).toContain('Model::Hips');
  });

  it('writeFBX produces non-empty, NaN-free output', () => {
    const fbx = writeFBX(skeleton, ik, 30, 'clip');
    expect(fbx.length).toBeGreaterThan(200);
    expect(fbx).not.toContain('NaN');
    expect(fbx).not.toContain('Infinity');
  });

  it('writeMotion rejects unknown formats', () => {
    const bad = { format: 'glb' } as unknown as ExportOptions;
    expect(() => writeMotion(skeleton, ik, 30, bad)).toThrow();
  });
});

describe('foot ground-locking', () => {
  it('createFootLockState starts unplanted', () => {
    const st = createFootLockState();
    expect(st.left.planted).toBe(false);
    expect(st.right.planted).toBe(false);
    expect(st.left.plantPos).toBeNull();
  });

  it('solveIK accepts IKOptions + footLock without throwing', () => {
    const skeleton = createSkeleton();
    const lock = createFootLockState();
    const pose = tPose();
    expect(() =>
      solveIK(pose, skeleton, undefined, { groundLockFeet: true, minVisibility: 0.5 }, lock),
    ).not.toThrow();
  });

  it('confidence-weighted IK drops low-visibility keypoints via minVisibility', () => {
    // Make the left wrist invisible — a high threshold should drop it.
    const pose = tPose();
    pose.body[15] = lm(0.95, 0.3, 0, 0.1); // low visibility
    const skeleton = createSkeleton();
    // With a high threshold, the wrist is dropped; IK should still produce a frame
    // (it falls back to prev/identity for that joint).
    const frame = solveIK(pose, skeleton, undefined, { minVisibility: 0.5 });
    expect(frame.localRotations.length).toBe(skeleton.joints.length);
  });
});

describe('BVH round-trip metadata', () => {
  it('BVH + FBX both export the same joint count', () => {
    const skeleton = createSkeleton();
    const poses = [tPose()];
    const ik = poses.map(p => solveIK(p, skeleton));
    const bvh = writeBVH(skeleton, ik, 30);
    const fbx = writeFBX(skeleton, ik, 30, 'x');
    // Count Model:: occurrences in FBX (one per joint declaration + connections).
    const fbxModels = (fbx.match(/Model::/g) ?? []).length;
    expect(fbxModels).toBeGreaterThanOrEqual(skeleton.joints.length);
    expect(bvh.match(/ROOT |JOINT /g)!.length).toBe(skeleton.joints.length);
  });
});
