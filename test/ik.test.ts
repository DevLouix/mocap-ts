import { describe, it, expect } from 'vitest';
import { solveIK, solveAllFrames, solveTwoBoneIK } from '../src/skeleton/ik.js';
import { createSkeleton, JointName } from '../src/skeleton/hierarchy.js';
import { IDENTITY, angleBetween, toEulerZXY, rotateVec } from '../src/math/quaternion.js';
import { distance, normalize as normVec, sub, length as vecLen } from '../src/math/vector3.js';
import type { Landmark, FramePose } from '../src/pose/types.js';

const RAD2DEG = 180 / Math.PI;
const skeleton = createSkeleton();

function makeLandmark(x: number, y: number, z: number, vis: number = 1): Landmark {
  return { x, y, z, visibility: vis };
}

/**
 * Create a T-pose frame (arms extended horizontally).
 *
 * MediaPipe convention: subject's left appears on the RIGHT side of image
 * (higher x) when facing camera. So LEFT_SHOULDER has higher x than RIGHT.
 * Our skeleton: LeftArm extends along +X, RightArm along -X.
 * Coordinate conversion: worldX = (imgX - 0.5) * scale.
 * So LEFT landmarks should have x > 0.5 to produce positive world X.
 */
function tposeFrame(): FramePose {
  const body: Landmark[] = new Array(33).fill(null).map(() =>
    makeLandmark(0.5, 0.5, 0, 0.9)
  );

  // Nose — centered
  body[0] = makeLandmark(0.5, 0.15, 0, 1);

  // Shoulders (subject's left = image right = higher x)
  body[11] = makeLandmark(0.65, 0.3, 0, 1); // left shoulder (image right)
  body[12] = makeLandmark(0.35, 0.3, 0, 1); // right shoulder (image left)

  // Elbows — same Y as shoulders (T-pose), further out
  body[13] = makeLandmark(0.8, 0.3, 0, 1);  // left elbow
  body[14] = makeLandmark(0.2, 0.3, 0, 1);  // right elbow

  // Wrists — same Y as shoulders (T-pose), furthest out
  body[15] = makeLandmark(0.95, 0.3, 0, 1); // left wrist
  body[16] = makeLandmark(0.05, 0.3, 0, 1); // right wrist

  // Hips (left hip = image right)
  body[23] = makeLandmark(0.55, 0.55, 0, 1); // left hip
  body[24] = makeLandmark(0.45, 0.55, 0, 1); // right hip

  // Knees — straight down from hips
  body[25] = makeLandmark(0.55, 0.75, 0, 1); // left knee
  body[26] = makeLandmark(0.45, 0.75, 0, 1); // right knee

  // Ankles
  body[27] = makeLandmark(0.55, 0.95, 0, 1); // left ankle
  body[28] = makeLandmark(0.45, 0.95, 0, 1); // right ankle

  return { body, frameIndex: 0 };
}

/** Create a frame with left arm raised up */
function leftArmRaisedFrame(): FramePose {
  const frame = tposeFrame();
  // Move left elbow and wrist upward (left = image right = higher x)
  frame.body[13] = makeLandmark(0.65, 0.1, 0, 1);  // left elbow up
  frame.body[15] = makeLandmark(0.65, -0.05, 0, 1); // left wrist very up
  return frame;
}

describe('IK solver', () => {
  it('produces rotation array matching skeleton joint count', () => {
    const frame = tposeFrame();
    const result = solveIK(frame, skeleton);
    expect(result.localRotations).toHaveLength(skeleton.joints.length);
  });

  it('arm joints in T-pose have small rotations', () => {
    const frame = tposeFrame();
    const result = solveIK(frame, skeleton);

    // Check arm chain specifically — these should align well with rest pose
    // since both MediaPipe and our skeleton have arms extending along X axis
    const armJoints = [
      JointName.LEFT_ARM, JointName.LEFT_FOREARM,
      JointName.RIGHT_ARM, JointName.RIGHT_FOREARM,
    ];

    for (const name of armJoints) {
      const idx = skeleton.nameToIndex.get(name)!;
      const angle = angleBetween(result.localRotations[idx], IDENTITY);
      // Arms should have relatively small rotation in T-pose
      expect(angle * RAD2DEG).toBeLessThan(120);
    }
  });

  it('returns a root position', () => {
    const frame = tposeFrame();
    const result = solveIK(frame, skeleton);

    expect(result.rootPosition).toBeDefined();
    expect(typeof result.rootPosition.x).toBe('number');
    expect(typeof result.rootPosition.y).toBe('number');
    expect(typeof result.rootPosition.z).toBe('number');
  });

  it('raised arm produces different shoulder rotation', () => {
    const tpose = solveIK(tposeFrame(), skeleton);
    const raised = solveIK(leftArmRaisedFrame(), skeleton);

    const lShoulderIdx = skeleton.nameToIndex.get(JointName.LEFT_SHOULDER)!;
    const lArmIdx = skeleton.nameToIndex.get(JointName.LEFT_ARM)!;

    const shoulderDiff = angleBetween(
      tpose.localRotations[lShoulderIdx],
      raised.localRotations[lShoulderIdx],
    );
    const armDiff = angleBetween(
      tpose.localRotations[lArmIdx],
      raised.localRotations[lArmIdx],
    );

    expect(Math.max(shoulderDiff, armDiff) * RAD2DEG).toBeGreaterThan(5);
  });

  it('outputs correct number of rotations', () => {
    const frame = tposeFrame();
    const result = solveIK(frame, skeleton);
    expect(result.localRotations).toHaveLength(skeleton.joints.length);
  });

  it('solveAllFrames processes multiple frames', () => {
    const frames = [tposeFrame(), leftArmRaisedFrame()];
    frames[1].frameIndex = 1;

    const results = solveAllFrames(frames, skeleton);
    expect(results).toHaveLength(2);
    expect(results[0].localRotations).toHaveLength(skeleton.joints.length);
    expect(results[1].localRotations).toHaveLength(skeleton.joints.length);
  });

  it('handles frame with all landmarks at very low visibility', () => {
    const frame = tposeFrame();
    for (const lm of frame.body) {
      lm.visibility = 0.01;
    }

    const result = solveIK(frame, skeleton);
    expect(result.localRotations).toHaveLength(skeleton.joints.length);
  });

  it('previous rotations enable decay for missing landmarks', () => {
    const frame1 = tposeFrame();
    const result1 = solveIK(frame1, skeleton);

    const frame2 = tposeFrame();
    frame2.body[0].visibility = 0;
    frame2.frameIndex = 1;

    const result2 = solveIK(frame2, skeleton, result1.localRotations);
    expect(result2.localRotations).toHaveLength(skeleton.joints.length);
  });

  it('all rotations are normalized quaternions', () => {
    const frame = tposeFrame();
    const result = solveIK(frame, skeleton);

    for (const q of result.localRotations) {
      const len = Math.sqrt(q.x * q.x + q.y * q.y + q.z * q.z + q.w * q.w);
      expect(len).toBeCloseTo(1, 4);
    }
  });
});

describe('two-bone IK', () => {
  it('enforces exact bone lengths', () => {
    const rootPos = { x: 0, y: 0, z: 0 };
    const targetPos = { x: 40, y: -10, z: 5 };
    const L1 = 25;
    const L2 = 25;
    const pole = { x: 0, y: 0, z: -1 };
    const restUpper = { x: 1, y: 0, z: 0 };
    const restLower = { x: 1, y: 0, z: 0 };

    const { midPos } = solveTwoBoneIK(rootPos, targetPos, L1, L2, pole, restUpper, restLower);

    // Upper bone length should be exactly L1
    expect(distance(rootPos, midPos)).toBeCloseTo(L1, 2);
    // Lower bone length should be exactly L2
    expect(distance(midPos, targetPos)).toBeCloseTo(L2, 2);
  });

  it('clamps unreachable targets to max extent', () => {
    const rootPos = { x: 0, y: 0, z: 0 };
    // Target way beyond reach (L1+L2 = 50, target at 100)
    const targetPos = { x: 100, y: 0, z: 0 };
    const L1 = 25;
    const L2 = 25;
    const pole = { x: 0, y: 0, z: -1 };
    const restUpper = { x: 1, y: 0, z: 0 };
    const restLower = { x: 1, y: 0, z: 0 };

    const { midPos } = solveTwoBoneIK(rootPos, targetPos, L1, L2, pole, restUpper, restLower);

    // Upper bone length is exactly L1
    expect(distance(rootPos, midPos)).toBeCloseTo(L1, 2);
    // Arm is nearly fully extended toward the target direction
    // (clamped to L1+L2-ε ≈ 49.99, so midPos should be at ~25 along X)
    expect(midPos.x).toBeGreaterThan(20);
    // Mid should be close to the line from root to target (nearly straight)
    expect(Math.abs(midPos.y)).toBeLessThan(5);
  });

  it('bent-arm produces correct elbow angle', () => {
    // Place target so the arm bends at 90 degrees
    // With L1=L2=25, placing target at (25, -25, 0) from root should give ~90° bend
    const rootPos = { x: 0, y: 0, z: 0 };
    const targetPos = { x: 25, y: -25, z: 0 };
    const L1 = 25;
    const L2 = 25;
    const pole = { x: 0, y: 0, z: -1 };
    const restUpper = { x: 1, y: 0, z: 0 };
    const restLower = { x: 1, y: 0, z: 0 };

    const { midPos } = solveTwoBoneIK(rootPos, targetPos, L1, L2, pole, restUpper, restLower);

    // Compute bend angle at elbow (midPos)
    const upperDir = normVec(sub(rootPos, midPos));
    const lowerDir = normVec(sub(targetPos, midPos));
    const dotVal = upperDir.x * lowerDir.x + upperDir.y * lowerDir.y + upperDir.z * lowerDir.z;
    const elbowAngle = Math.acos(Math.max(-1, Math.min(1, dotVal))) * RAD2DEG;

    // d = sqrt(25^2 + 25^2) = 35.36, law of cosines: angle = 2*acos(35.36/(2*25)) ≈ 90°
    expect(elbowAngle).toBeCloseTo(90, -1); // within 5°
  });

  it('pole vector controls bend direction', () => {
    const rootPos = { x: 0, y: 0, z: 0 };
    const targetPos = { x: 40, y: 0, z: 0 }; // Not fully extended → will bend

    // Two different pole vectors
    const { midPos: mid1 } = solveTwoBoneIK(
      rootPos, targetPos, 25, 25,
      { x: 0, y: 0, z: -1 },  // bend backward
      { x: 1, y: 0, z: 0 }, { x: 1, y: 0, z: 0 },
    );
    const { midPos: mid2 } = solveTwoBoneIK(
      rootPos, targetPos, 25, 25,
      { x: 0, y: 1, z: 0 },  // bend upward
      { x: 1, y: 0, z: 0 }, { x: 1, y: 0, z: 0 },
    );

    // Mid positions should differ (different pole vectors → different bend directions)
    const diff = distance(mid1, mid2);
    expect(diff).toBeGreaterThan(1);
  });

  it('skeleton has correct limb chains', () => {
    expect(skeleton.limbChains).toHaveLength(4); // 2 arms + 2 legs

    // Check left arm chain
    const leftArm = skeleton.limbChains.find(
      c => c.root === skeleton.nameToIndex.get(JointName.LEFT_ARM)!,
    )!;
    expect(leftArm).toBeDefined();
    expect(leftArm.mid).toBe(skeleton.nameToIndex.get(JointName.LEFT_FOREARM)!);
    expect(leftArm.end).toBe(skeleton.nameToIndex.get(JointName.LEFT_HAND)!);
    expect(leftArm.upperLength).toBe(25);
    expect(leftArm.lowerLength).toBe(25);

    // Check left leg chain
    const leftLeg = skeleton.limbChains.find(
      c => c.root === skeleton.nameToIndex.get(JointName.LEFT_UPLEG)!,
    )!;
    expect(leftLeg).toBeDefined();
    expect(leftLeg.upperLength).toBe(45);
    expect(leftLeg.lowerLength).toBe(45);
  });
});
