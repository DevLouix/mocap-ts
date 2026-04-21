import { BodyLandmark } from '../pose/types.js';
import { JointName } from './hierarchy.js';
import type { Landmark, FramePose } from '../pose/types.js';
import type { Vec3 } from '../math/vector3.js';
import { midpoint, lerp, distance } from '../math/vector3.js';

/**
 * Mapping from skeleton joint name to one or more MediaPipe body landmark indices.
 * When multiple landmarks are listed, their position is interpolated.
 */
export interface JointMapping {
  joint: string;
  /** MediaPipe landmark index(es). Single = direct, array = interpolated. */
  landmarks: number | number[];
  /** Interpolation weights (only if landmarks is array). Defaults to equal weights. */
  weights?: number[];
}

/**
 * Direct mappings from skeleton joints to MediaPipe body landmarks.
 * Some joints require interpolation between multiple landmarks.
 */
export const BODY_JOINT_MAPPINGS: JointMapping[] = [
  // Hips = midpoint of left + right hip
  { joint: JointName.HIPS, landmarks: [BodyLandmark.LEFT_HIP, BodyLandmark.RIGHT_HIP] },

  // Spine chain = interpolated between hip center and shoulder center
  { joint: JointName.SPINE, landmarks: [BodyLandmark.LEFT_HIP, BodyLandmark.RIGHT_HIP, BodyLandmark.LEFT_SHOULDER, BodyLandmark.RIGHT_SHOULDER], weights: [0.3, 0.3, 0.2, 0.2] },
  { joint: JointName.SPINE1, landmarks: [BodyLandmark.LEFT_HIP, BodyLandmark.RIGHT_HIP, BodyLandmark.LEFT_SHOULDER, BodyLandmark.RIGHT_SHOULDER], weights: [0.15, 0.15, 0.35, 0.35] },
  { joint: JointName.SPINE2, landmarks: [BodyLandmark.LEFT_SHOULDER, BodyLandmark.RIGHT_SHOULDER] },

  // Head chain
  { joint: JointName.NECK, landmarks: [BodyLandmark.LEFT_SHOULDER, BodyLandmark.RIGHT_SHOULDER], weights: [0.5, 0.5] },
  { joint: JointName.HEAD, landmarks: BodyLandmark.NOSE },

  // Left arm
  { joint: JointName.LEFT_SHOULDER, landmarks: BodyLandmark.LEFT_SHOULDER },
  { joint: JointName.LEFT_ARM, landmarks: BodyLandmark.LEFT_SHOULDER },
  { joint: JointName.LEFT_FOREARM, landmarks: BodyLandmark.LEFT_ELBOW },
  { joint: JointName.LEFT_HAND, landmarks: BodyLandmark.LEFT_WRIST },

  // Right arm
  { joint: JointName.RIGHT_SHOULDER, landmarks: BodyLandmark.RIGHT_SHOULDER },
  { joint: JointName.RIGHT_ARM, landmarks: BodyLandmark.RIGHT_SHOULDER },
  { joint: JointName.RIGHT_FOREARM, landmarks: BodyLandmark.RIGHT_ELBOW },
  { joint: JointName.RIGHT_HAND, landmarks: BodyLandmark.RIGHT_WRIST },

  // Left leg
  { joint: JointName.LEFT_UPLEG, landmarks: BodyLandmark.LEFT_HIP },
  { joint: JointName.LEFT_LEG, landmarks: BodyLandmark.LEFT_KNEE },
  { joint: JointName.LEFT_FOOT, landmarks: BodyLandmark.LEFT_ANKLE },

  // Right leg
  { joint: JointName.RIGHT_UPLEG, landmarks: BodyLandmark.RIGHT_HIP },
  { joint: JointName.RIGHT_LEG, landmarks: BodyLandmark.RIGHT_KNEE },
  { joint: JointName.RIGHT_FOOT, landmarks: BodyLandmark.RIGHT_ANKLE },
];

/**
 * Convert a MediaPipe landmark (normalized 0-1 coordinates) to world-space Vec3 (cm).
 * MediaPipe Y is inverted (0 = top), Z is depth toward camera.
 * We convert to: X = right, Y = up, Z = forward (standard 3D convention).
 */
function landmarkToVec3(lm: Landmark, scale: number = 170): Vec3 {
  return {
    x: (lm.x - 0.5) * scale,
    y: -(lm.y - 0.5) * scale,  // flip Y (MediaPipe 0=top)
    z: -lm.z * scale,           // flip Z (MediaPipe Z is toward camera)
  };
}

/**
 * Get the world-space position of a skeleton joint from a frame's body landmarks.
 */
export function getJointPosition(mapping: JointMapping, body: Landmark[], scale: number = 170): Vec3 | null {
  if (typeof mapping.landmarks === 'number') {
    const lm = body[mapping.landmarks];
    if (!lm || lm.visibility < 0.1) return null;
    return landmarkToVec3(lm, scale);
  }

  // Interpolated position from multiple landmarks
  const indices = mapping.landmarks;
  const weights = mapping.weights ?? indices.map(() => 1 / indices.length);

  let x = 0, y = 0, z = 0;
  let totalWeight = 0;

  for (let i = 0; i < indices.length; i++) {
    const lm = body[indices[i]];
    if (!lm || lm.visibility < 0.1) continue;
    const w = weights[i] * lm.visibility;
    const pos = landmarkToVec3(lm, scale);
    x += pos.x * w;
    y += pos.y * w;
    z += pos.z * w;
    totalWeight += w;
  }

  if (totalWeight < 0.01) return null;
  return { x: x / totalWeight, y: y / totalWeight, z: z / totalWeight };
}

/**
 * Compute root (Hips) translation from image-space (normalized) landmarks.
 *
 * BlazePose "world landmarks" are hip-relative, so root position is always
 * near (0,0,0) in world space. Instead, we use the **normalized** (image-space)
 * hip center position to derive translation, with bodyScale estimated from
 * the shoulder-to-hip distance in normalized coords vs known skeleton height.
 *
 * This is the same approach as extract_root_translation() in our Python pipeline.
 */
function computeRootFromImageSpace(body: Landmark[], scale: number): Vec3 | null {
  const lHip = body[BodyLandmark.LEFT_HIP];
  const rHip = body[BodyLandmark.RIGHT_HIP];
  const lShoulder = body[BodyLandmark.LEFT_SHOULDER];
  const rShoulder = body[BodyLandmark.RIGHT_SHOULDER];

  if (!lHip || !rHip || lHip.visibility < 0.1 || rHip.visibility < 0.1) {
    return null;
  }

  // Hip center in normalized image coords (0-1)
  const hipCenterX = (lHip.x + rHip.x) / 2;
  const hipCenterY = (lHip.y + rHip.y) / 2;

  // Estimate body scale from shoulder-to-hip distance in image space
  // vs the known skeleton height (~65 cm from hips to shoulders)
  let bodyScale = scale;
  if (lShoulder && rShoulder &&
      lShoulder.visibility > 0.3 && rShoulder.visibility > 0.3) {
    const shoulderCenterX = (lShoulder.x + rShoulder.x) / 2;
    const shoulderCenterY = (lShoulder.y + rShoulder.y) / 2;
    const imageTorsoHeight = Math.sqrt(
      (hipCenterX - shoulderCenterX) ** 2 + (hipCenterY - shoulderCenterY) ** 2,
    );
    // Skeleton torso height: Hips→Spine(10)→Spine1(10)→Spine2(10)→Neck midpoint ≈ 35cm
    const skeletonTorsoHeight = 35;
    if (imageTorsoHeight > 0.01) {
      bodyScale = skeletonTorsoHeight / imageTorsoHeight;
    }
  }

  return {
    x: (hipCenterX - 0.5) * bodyScale,
    y: -(hipCenterY - 0.5) * bodyScale,
    z: 0, // No reliable Z from image-space coordinates
  };
}

/**
 * Resolve all joint positions for a frame.
 * Returns a Map from joint name to world-space position.
 *
 * For the Hips joint, uses image-space (normalized) landmarks to compute
 * root translation rather than world landmarks (which are hip-relative
 * and always near origin).
 */
export function resolveJointPositions(
  frame: FramePose,
  scale: number = 170,
): Map<string, Vec3> {
  const positions = new Map<string, Vec3>();

  for (const mapping of BODY_JOINT_MAPPINGS) {
    const pos = getJointPosition(mapping, frame.body, scale);
    if (pos) {
      positions.set(mapping.joint, pos);
    }
  }

  // Override Hips position with image-space root translation
  const rootPos = computeRootFromImageSpace(frame.body, scale);
  if (rootPos) {
    positions.set(JointName.HIPS, rootPos);
  }

  return positions;
}

/**
 * Get the mapping for a specific joint name.
 */
export function getMappingForJoint(jointName: string): JointMapping | undefined {
  return BODY_JOINT_MAPPINGS.find(m => m.joint === jointName);
}
