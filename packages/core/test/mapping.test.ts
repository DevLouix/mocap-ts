import { describe, it, expect } from 'vitest';
import {
  BODY_JOINT_MAPPINGS, getJointPosition, resolveJointPositions, getMappingForJoint,
} from '../src/skeleton/mapping.js';
import { createSkeleton, JointName } from '../src/skeleton/hierarchy.js';
import type { Landmark, FramePose } from '../src/pose/types.js';

function makeLandmark(x: number, y: number, z: number, vis: number = 1): Landmark {
  return { x, y, z, visibility: vis };
}

/** Create a T-pose frame with all 33 body landmarks at plausible positions */
function makeTposeFrame(): FramePose {
  const body: Landmark[] = new Array(33).fill(null).map(() =>
    makeLandmark(0.5, 0.5, 0, 0.9)
  );

  // Place key landmarks in approximate positions
  // MediaPipe convention: subject's left = image right (higher x) when facing camera
  // Head area
  body[0] = makeLandmark(0.5, 0.15, 0);       // nose
  body[7] = makeLandmark(0.55, 0.15, 0);      // left ear (image right)
  body[8] = makeLandmark(0.45, 0.15, 0);      // right ear (image left)

  // Shoulders
  body[11] = makeLandmark(0.65, 0.3, 0);      // left shoulder (image right)
  body[12] = makeLandmark(0.35, 0.3, 0);      // right shoulder (image left)

  // Elbows (arms extended in T-pose)
  body[13] = makeLandmark(0.8, 0.3, 0);       // left elbow
  body[14] = makeLandmark(0.2, 0.3, 0);       // right elbow

  // Wrists
  body[15] = makeLandmark(0.95, 0.3, 0);      // left wrist
  body[16] = makeLandmark(0.05, 0.3, 0);      // right wrist

  // Hips
  body[23] = makeLandmark(0.55, 0.55, 0);     // left hip
  body[24] = makeLandmark(0.45, 0.55, 0);     // right hip

  // Knees
  body[25] = makeLandmark(0.55, 0.75, 0);     // left knee
  body[26] = makeLandmark(0.45, 0.75, 0);     // right knee

  // Ankles
  body[27] = makeLandmark(0.55, 0.95, 0);     // left ankle
  body[28] = makeLandmark(0.45, 0.95, 0);     // right ankle

  return { body, frameIndex: 0 };
}

describe('skeleton mapping', () => {
  it('every skeleton joint has a mapping', () => {
    const skeleton = createSkeleton();
    for (const joint of skeleton.joints) {
      const mapping = getMappingForJoint(joint.name);
      expect(mapping, `Missing mapping for ${joint.name}`).toBeDefined();
    }
  });

  it('all mapped landmark indices are valid (0-32)', () => {
    for (const mapping of BODY_JOINT_MAPPINGS) {
      const indices = typeof mapping.landmarks === 'number'
        ? [mapping.landmarks]
        : mapping.landmarks;
      for (const idx of indices) {
        expect(idx).toBeGreaterThanOrEqual(0);
        expect(idx).toBeLessThanOrEqual(32);
      }
    }
  });

  it('Hips maps to midpoint of left + right hip', () => {
    const mapping = getMappingForJoint(JointName.HIPS)!;
    expect(mapping.landmarks).toEqual([23, 24]); // LEFT_HIP, RIGHT_HIP
  });

  it('getJointPosition returns position for direct mapping', () => {
    const body: Landmark[] = new Array(33).fill(null).map(() =>
      makeLandmark(0.5, 0.5, 0, 0.9)
    );
    body[0] = makeLandmark(0.5, 0.2, 0.1, 0.95); // nose

    const headMapping = getMappingForJoint(JointName.HEAD)!;
    const pos = getJointPosition(headMapping, body);

    expect(pos).not.toBeNull();
    expect(pos!.x).toBeCloseTo(0, 0); // centered
    expect(pos!.y).toBeGreaterThan(0); // above center (Y flipped)
  });

  it('getJointPosition returns null for invisible landmarks', () => {
    const body: Landmark[] = new Array(33).fill(null).map(() =>
      makeLandmark(0.5, 0.5, 0, 0.0) // all invisible
    );

    const mapping = getMappingForJoint(JointName.HEAD)!;
    const pos = getJointPosition(mapping, body);

    expect(pos).toBeNull();
  });

  it('resolveJointPositions returns positions for all visible joints', () => {
    const frame = makeTposeFrame();
    const positions = resolveJointPositions(frame);

    // Should have positions for all 20 skeleton joints
    expect(positions.size).toBe(20);

    // Hips should be roughly centered
    const hips = positions.get(JointName.HIPS)!;
    expect(hips.x).toBeCloseTo(0, 0);

    // Subject's left shoulder = image right (higher x) → positive world X
    // Skeleton: LeftArm extends along +X
    const lShoulder = positions.get(JointName.LEFT_SHOULDER)!;
    const rShoulder = positions.get(JointName.RIGHT_SHOULDER)!;
    expect(lShoulder.x).toBeGreaterThan(rShoulder.x);
  });

  it('interpolated joints use weights correctly', () => {
    const body: Landmark[] = new Array(33).fill(null).map(() =>
      makeLandmark(0.5, 0.5, 0, 0.9)
    );
    // Left hip at y=0.6, right hip at y=0.6
    // Left shoulder at y=0.3, right shoulder at y=0.3
    body[23] = makeLandmark(0.55, 0.6, 0, 1.0);
    body[24] = makeLandmark(0.45, 0.6, 0, 1.0);
    body[11] = makeLandmark(0.55, 0.3, 0, 1.0);
    body[12] = makeLandmark(0.45, 0.3, 0, 1.0);

    // Spine (weights: 0.3 hip, 0.3 hip, 0.2 shoulder, 0.2 shoulder)
    const spineMapping = getMappingForJoint(JointName.SPINE)!;
    const spinePos = getJointPosition(spineMapping, body)!;

    // Spine1 (weights: 0.15 hip, 0.15 hip, 0.35 shoulder, 0.35 shoulder)
    const spine1Mapping = getMappingForJoint(JointName.SPINE1)!;
    const spine1Pos = getJointPosition(spine1Mapping, body)!;

    // Spine should be closer to hips (more hip weight)
    // Spine1 should be closer to shoulders (more shoulder weight)
    // In world space, higher Y = further from camera top = lower on body
    // Hips at y=0.6 → world Y = -(0.6-0.5)*170 = -17
    // Shoulders at y=0.3 → world Y = -(0.3-0.5)*170 = +34
    expect(spinePos.y).toBeLessThan(spine1Pos.y);
  });

  it('root translation changes when hip moves across image', () => {
    // Frame 1: person centered
    const frame1 = makeTposeFrame();
    const pos1 = resolveJointPositions(frame1);
    const hips1 = pos1.get(JointName.HIPS)!;

    // Frame 2: person shifted right in image (all landmarks +0.2 in X)
    const frame2 = makeTposeFrame();
    for (const lm of frame2.body) {
      lm.x += 0.2;
    }
    frame2.frameIndex = 1;
    const pos2 = resolveJointPositions(frame2);
    const hips2 = pos2.get(JointName.HIPS)!;

    // Root X should increase (moved right in image = positive world X)
    expect(hips2.x).toBeGreaterThan(hips1.x);
    // The shift should be proportional (not zero)
    expect(hips2.x - hips1.x).toBeGreaterThan(1);
  });

  it('root translation is derived from image-space coordinates', () => {
    // With centered hips (x=0.5, y=0.5), root should be near origin
    const frame = makeTposeFrame();
    const positions = resolveJointPositions(frame);
    const hips = positions.get(JointName.HIPS)!;

    // Hips at image center (0.5, 0.55) → rootX ≈ 0, rootY slightly below center
    expect(Math.abs(hips.x)).toBeLessThan(5);
    // Z from image space should be 0 (no reliable depth from 2D)
    expect(hips.z).toBe(0);
  });
});
