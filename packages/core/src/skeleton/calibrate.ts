import type { FramePose } from '../pose/types.js';
import type { SkeletonDef } from './hierarchy.js';
import { JointName, createSkeleton } from './hierarchy.js';
import { resolveJointPositions } from './mapping.js';
import { distance } from '../math/vector3.js';
import { length as vecLen } from '../math/vector3.js';
import type { Vec3 } from '../math/vector3.js';

/**
 * Segment definition: a pair of joints whose distance we measure.
 */
interface Segment {
  from: string;
  to: string;
  /** Which skeleton joint's offset magnitude to scale */
  targetJoint: string;
}

/**
 * ARM segments to measure for calibration (diagonal distance works for arms
 * since they frequently extend perpendicular to camera).
 */
const ARM_SEGMENTS: Segment[][] = [
  // Upper arms
  [
    { from: JointName.LEFT_ARM, to: JointName.LEFT_FOREARM, targetJoint: JointName.LEFT_FOREARM },
    { from: JointName.RIGHT_ARM, to: JointName.RIGHT_FOREARM, targetJoint: JointName.RIGHT_FOREARM },
  ],
  // Forearms
  [
    { from: JointName.LEFT_FOREARM, to: JointName.LEFT_HAND, targetJoint: JointName.LEFT_HAND },
    { from: JointName.RIGHT_FOREARM, to: JointName.RIGHT_HAND, targetJoint: JointName.RIGHT_HAND },
  ],
];

/**
 * Get the Pth percentile from a sorted array.
 */
function percentile(sorted: number[], p: number): number {
  const idx = Math.min(Math.floor(sorted.length * p), sorted.length - 1);
  return sorted[idx];
}

/**
 * Measure the 3D distance between two joints across sampled frames.
 * Returns p90 of detected distances, or null if insufficient data.
 */
function measureDistance(
  sampledPositions: Map<string, Vec3>[],
  fromJoint: string,
  toJoint: string,
  minDist: number = 0.5,
): number | null {
  const dists: number[] = [];
  for (const positions of sampledPositions) {
    const posA = positions.get(fromJoint);
    const posB = positions.get(toJoint);
    if (posA && posB) {
      const d = distance(posA, posB);
      if (d > minDist) dists.push(d);
    }
  }
  if (dists.length < 3) return null;
  dists.sort((a, b) => a - b);
  return percentile(dists, 0.9);
}



/**
 * Scale a joint's offset to a new length, preserving direction.
 */
function scaleJointOffset(joint: { offset: Vec3; boneLength: number }, newLength: number): void {
  const currentLength = joint.boneLength;
  if (currentLength < 0.01) return;
  const dir: Vec3 = {
    x: joint.offset.x / currentLength,
    y: joint.offset.y / currentLength,
    z: joint.offset.z / currentLength,
  };
  joint.offset = {
    x: dir.x * newLength,
    y: dir.y * newLength,
    z: dir.z * newLength,
  };
  joint.boneLength = newLength;
}

/**
 * Calibrate skeleton bone lengths from detected pose data.
 *
 * MoveNet detects 2D keypoints which get mapped to a 170cm world space.
 * The distances between landmarks reveal the person's actual proportions,
 * but are foreshortened when limbs point toward/away from the camera.
 *
 * Strategy: measure distances across many frames, take the 90th percentile
 * (captures near-maximum extension, robust to foreshortening + outliers),
 * then scale skeleton offsets to match.
 *
 * Calibrates: limbs (arms/legs), torso (spine chain), head, shoulder/hip widths.
 */
export function calibrateSkeleton(
  poses: FramePose[],
  verbose?: boolean,
): SkeletonDef {
  const skeleton = createSkeleton();
  const { joints, nameToIndex } = skeleton;

  // Sample evenly (max 60 frames for speed)
  const maxSamples = 60;
  const step = Math.max(1, Math.floor(poses.length / maxSamples));
  const sampledPoses = poses.filter((_, i) => i % step === 0);

  // Resolve all joint positions for sampled frames
  const sampledPositions = sampledPoses.map(p => resolveJointPositions(p));

  const logScale = (name: string, oldLen: number, newLen: number) => {
    if (verbose) {
      console.error(
        `[calibrate] ${name}: ${oldLen.toFixed(1)}cm → ${newLen.toFixed(1)}cm (${((newLen / oldLen) * 100).toFixed(0)}%)`,
      );
    }
  };

  // --- 1a. Calibrate arm chains (diagonal distance — arms extend horizontally) ---
  for (const group of ARM_SEGMENTS) {
    const p90s: number[] = [];
    for (const seg of group) {
      const d = measureDistance(sampledPositions, seg.from, seg.to);
      if (d !== null) p90s.push(d);
    }
    if (p90s.length === 0) continue;
    const detectedLength = p90s.reduce((a, b) => a + b, 0) / p90s.length;

    for (const seg of group) {
      const jointIdx = nameToIndex.get(seg.targetJoint);
      if (jointIdx === undefined) continue;
      const joint = joints[jointIdx];
      const oldLen = joint.boneLength;
      scaleJointOffset(joint, detectedLength);
      logScale(seg.targetJoint, oldLen, detectedLength);
    }
  }

  // NOTE: Legs are NOT calibrated from 2D detection.
  // From a front camera, legs always appear foreshortened (knee bend is in
  // the depth axis, invisible in 2D). The default skeleton proportions
  // (45+45=90cm for a 170cm person) work well because the IK naturally
  // bends the knees forward to reach the shorter 2D target distances,
  // producing realistic 3D poses with proper knee bend.

  // --- 2. Calibrate torso (spine chain) ---
  // Spine chain: Hips → Spine(10) → Spine1(10) → Spine2(10) = 30cm total
  // Detected: hip center → shoulder center
  const torsoLength = measureDistance(sampledPositions, JointName.HIPS, JointName.SPINE2, 5);
  if (torsoLength !== null) {
    const oldTorsoLength = 30; // Spine + Spine1 + Spine2 = 10+10+10
    const spineScale = torsoLength / oldTorsoLength;
    for (const name of [JointName.SPINE, JointName.SPINE1, JointName.SPINE2]) {
      const idx = nameToIndex.get(name)!;
      const joint = joints[idx];
      const oldLen = joint.boneLength;
      scaleJointOffset(joint, oldLen * spineScale);
      logScale(name, oldLen, oldLen * spineScale);
    }
  }

  // --- 3. Calibrate neck + head ---
  // Neck(5) + Head(10) = 15cm from shoulder center to nose
  // But Neck and Spine2 map to same landmark (shoulder center),
  // so measure from Neck to Head (shoulder center → nose)
  const headDist = measureDistance(sampledPositions, JointName.NECK, JointName.HEAD, 1);
  if (headDist !== null) {
    const oldHeadChain = 15; // Neck(5) + Head(10)
    const headScale = headDist / oldHeadChain;
    for (const name of [JointName.NECK, JointName.HEAD]) {
      const idx = nameToIndex.get(name)!;
      const joint = joints[idx];
      const oldLen = joint.boneLength;
      scaleJointOffset(joint, oldLen * headScale);
      logScale(name, oldLen, oldLen * headScale);
    }
  }

  // --- 4. Calibrate shoulder width ---
  // Full shoulder span: LeftShoulder(5,2,0) + LeftArm(10,0,0) = 15cm per side, 30cm total
  // Detected: LEFT_SHOULDER → RIGHT_SHOULDER
  const shoulderWidth = measureDistance(sampledPositions, JointName.LEFT_SHOULDER, JointName.RIGHT_SHOULDER, 5);
  if (shoulderWidth !== null) {
    const oldShoulderWidth = 30; // 15cm per side
    const shoulderScale = shoulderWidth / oldShoulderWidth;
    for (const name of [JointName.LEFT_SHOULDER, JointName.RIGHT_SHOULDER, JointName.LEFT_ARM, JointName.RIGHT_ARM]) {
      const idx = nameToIndex.get(name)!;
      const joint = joints[idx];
      const oldLen = joint.boneLength;
      scaleJointOffset(joint, oldLen * shoulderScale);
      logScale(name, oldLen, oldLen * shoulderScale);
    }
  }

  // --- 5. Calibrate hip width ---
  // Hip offset: LeftUpLeg(10,-5,0) → half-width ~10cm, full width ~20cm
  // Detected: LEFT_UPLEG → RIGHT_UPLEG (which maps to LEFT_HIP → RIGHT_HIP)
  const hipWidth = measureDistance(sampledPositions, JointName.LEFT_UPLEG, JointName.RIGHT_UPLEG, 2);
  if (hipWidth !== null) {
    // Each UpLeg offset has x=±10, y=-5. The x component determines width.
    // Current full width = 20cm (10 per side)
    const oldHipWidth = 20;
    const hipScale = hipWidth / oldHipWidth;
    for (const name of [JointName.LEFT_UPLEG, JointName.RIGHT_UPLEG]) {
      const idx = nameToIndex.get(name)!;
      const joint = joints[idx];
      const oldLen = joint.boneLength;
      scaleJointOffset(joint, oldLen * hipScale);
      logScale(name, oldLen, oldLen * hipScale);
    }
  }

  // --- 6. Update limb chain lengths to match calibrated joints ---
  for (const chain of skeleton.limbChains) {
    chain.upperLength = joints[chain.mid].boneLength;
    chain.lowerLength = joints[chain.end].boneLength;
  }

  return skeleton;
}
