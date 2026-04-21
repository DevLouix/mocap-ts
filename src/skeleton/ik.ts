import type { Vec3 } from '../math/vector3.js';
import {
  sub, normalize as normVec, length as vecLen, add, scale, dot, cross,
} from '../math/vector3.js';
import type { Quat } from '../math/quaternion.js';
import {
  IDENTITY, fromUnitVectors, multiply, inverse, normalize as normQuat,
  slerp, rotateVec, fromAxisAngle, swingTwist, angleBetween,
} from '../math/quaternion.js';
import type { SkeletonDef, Joint, LimbChain } from './hierarchy.js';
import { getChildren, JointName } from './hierarchy.js';
import type { FramePose } from '../pose/types.js';
import { HandLandmark } from '../pose/types.js';
import { resolveJointPositions } from './mapping.js';

/**
 * Result of IK solve for a single frame.
 */
export interface IKFrame {
  /** Root (Hips) world position in cm */
  rootPosition: Vec3;
  /** Local-space rotation per joint (indexed by joint index) */
  localRotations: Quat[];
}

/**
 * Two-bone analytic IK solver.
 *
 * Given root position A, target position C, bone lengths L1 and L2,
 * and a pole vector for preferred bend direction:
 *   1. Clamp distance |AC| to [|L1-L2|+ε, L1+L2-ε] (enforces reachability)
 *   2. Law of cosines → bend angle at A
 *   3. Elbow lies on a circle perpendicular to AC, pole vector picks the point
 *   4. Derive root and mid rotations from the solved positions
 *
 * Returns rotations for the root (upper bone) and mid (lower bone) joints.
 */
export function solveTwoBoneIK(
  rootPos: Vec3,
  targetPos: Vec3,
  L1: number,
  L2: number,
  pole: Vec3,
  restDirUpper: Vec3,
  restDirLower: Vec3,
): { rootRot: Quat; midRot: Quat; midPos: Vec3 } {
  const toTarget = sub(targetPos, rootPos);
  let d = vecLen(toTarget);

  // Clamp to reachable range
  const minDist = Math.abs(L1 - L2) + 0.01;
  const maxDist = L1 + L2 - 0.01;
  d = Math.max(minDist, Math.min(maxDist, d));

  // Law of cosines: angle at root joint
  const cosAngleA = (L1 * L1 + d * d - L2 * L2) / (2 * L1 * d);
  const angleA = Math.acos(Math.max(-1, Math.min(1, cosAngleA)));

  // Direction from root to target (clamped distance)
  const acDir = d > 1e-6 ? normVec(toTarget) : { x: 0, y: -1, z: 0 };

  // Build an orthonormal frame with acDir as the primary axis
  // Pole vector projected onto the plane perpendicular to acDir
  let poleCross = cross(acDir, pole);
  if (vecLen(poleCross) < 1e-6) {
    // Pole is parallel to AC — use a fallback
    poleCross = cross(acDir, { x: 0, y: 1, z: 0 });
    if (vecLen(poleCross) < 1e-6) {
      poleCross = cross(acDir, { x: 1, y: 0, z: 0 });
    }
  }
  const sideDir = normVec(poleCross);
  const poleDir = normVec(cross(sideDir, acDir));

  // Mid joint position: along acDir by L1*cos(angleA), plus perpendicular by L1*sin(angleA)
  const midAlongAC = L1 * Math.cos(angleA);
  const midPerp = L1 * Math.sin(angleA);
  const midPos: Vec3 = add(
    rootPos,
    add(scale(acDir, midAlongAC), scale(poleDir, midPerp)),
  );

  // Root rotation: from rest upper direction to actual upper direction
  const actualUpperDir = normVec(sub(midPos, rootPos));
  const rootRot = fromUnitVectors(restDirUpper, actualUpperDir);

  // Mid rotation: from rest lower direction to actual lower direction
  // Lower bone rest direction is the same as upper in local space (straight chain),
  // but we need to account for the root rotation first
  const actualLowerDir = normVec(sub(targetPos, midPos));
  // The rest lower direction in world space after root rotation
  const worldRestLower = rotateVec(rootRot, restDirLower);
  const midWorldRot = fromUnitVectors(worldRestLower, actualLowerDir);
  // Convert mid rotation to local space (relative to root rotation)
  const midRot = normQuat(multiply(inverse(rootRot), midWorldRot));

  // Combine: the mid's world rotation = rootRot * midRot
  // But we actually need the rotation applied AT the mid joint, not composed with root
  // In the hierarchy, mid's local rotation = parentWorldInv * midWorldRotation
  // parentWorld for mid = rootRot, so midLocal = rootRot^-1 * midWorld = midRot (as computed)

  return { rootRot: normQuat(rootRot), midRot: normQuat(midRot), midPos };
}

/** Decay factor for forearm twist when hands are not visible */
const TWIST_DECAY = 0.95;

/**
 * Compute forearm twist angle from hand landmarks.
 *
 * Uses the hand plane normal (wrist, index MCP, pinky MCP) to determine
 * how much the forearm is rotated around its own axis (pronation/supination).
 *
 * Returns the twist quaternion around the forearm axis, or null if
 * hand landmarks are not available.
 */
function computeForearmTwist(
  frame: FramePose,
  forearmDir: Vec3,
  isLeft: boolean,
): Quat | null {
  const hand = isLeft ? frame.leftHand : frame.rightHand;
  if (!hand || hand.landmarks.length < 21) return null;

  const wrist = hand.landmarks[HandLandmark.WRIST];
  const indexMcp = hand.landmarks[HandLandmark.INDEX_MCP];
  const pinkyMcp = hand.landmarks[HandLandmark.PINKY_MCP];

  if (wrist.visibility < 0.3 || indexMcp.visibility < 0.3 || pinkyMcp.visibility < 0.3) {
    return null;
  }

  // Compute hand plane normal from 3 hand points
  // Convert from normalized coords to approximate world space
  const bodyScale = 170;
  const toWorld = (lm: { x: number; y: number; z: number }) => ({
    x: (lm.x - 0.5) * bodyScale,
    y: -(lm.y - 0.5) * bodyScale,
    z: -lm.z * bodyScale,
  });

  const wPos = toWorld(wrist);
  const iPos = toWorld(indexMcp);
  const pPos = toWorld(pinkyMcp);

  const v1 = normVec(sub(iPos, wPos));
  const v2 = normVec(sub(pPos, wPos));
  const handNormal = normVec(cross(v1, v2));

  if (vecLen(handNormal) < 1e-6) return null;

  // The expected hand normal without any twist is perpendicular to the forearm
  // and pointing in the default direction (e.g. palm down in T-pose = -Y for arms)
  // We compute this from the forearm direction
  const forearmNorm = normVec(forearmDir);

  // Default palm normal: perpendicular to forearm, pointing down-ish
  // For T-pose arms: forearm along ±X, default palm normal is -Y
  let defaultNormal: Vec3 = { x: 0, y: -1, z: 0 };
  // Project default normal onto plane perpendicular to forearm
  const projDot = dot(defaultNormal, forearmNorm);
  defaultNormal = normVec(sub(defaultNormal, scale(forearmNorm, projDot)));

  if (vecLen(defaultNormal) < 1e-6) {
    // Forearm is vertical — use Z as default
    defaultNormal = { x: 0, y: 0, z: 1 };
    const projDot2 = dot(defaultNormal, forearmNorm);
    defaultNormal = normVec(sub(defaultNormal, scale(forearmNorm, projDot2)));
  }

  // Project actual hand normal onto plane perpendicular to forearm
  const handProjDot = dot(handNormal, forearmNorm);
  const projectedHandNormal = normVec(sub(handNormal, scale(forearmNorm, handProjDot)));

  if (vecLen(projectedHandNormal) < 1e-6) return null;

  // Twist angle = angle between default and actual hand normal around forearm axis
  const twistRot = fromUnitVectors(defaultNormal, projectedHandNormal);

  // Decompose to get only the twist component around the forearm axis
  const { twist } = swingTwist(twistRot, forearmNorm);
  return twist;
}

/**
 * Compute local joint rotations from landmark positions.
 *
 * For limb chains (arms/legs), uses two-bone analytic IK with pole vectors
 * to enforce bone lengths and stable bend directions.
 *
 * For other joints (spine/head/shoulders), uses direction-based IK
 * via fromUnitVectors (well-detected joints, no length constraints needed).
 *
 * For forearm joints, adds twist decomposition from hand landmarks
 * (pronation/supination) when available, decaying toward identity when not.
 */
export function solveIK(
  frame: FramePose,
  skeleton: SkeletonDef,
  prevRotations?: Quat[],
): IKFrame {
  const positions = resolveJointPositions(frame);
  const { joints, limbChains } = skeleton;
  const localRotations: Quat[] = new Array(joints.length).fill(IDENTITY);
  const worldRotations: Quat[] = new Array(joints.length).fill(IDENTITY);

  // Build set of joints that are part of limb chains (handled separately)
  const limbJointSet = new Set<number>();
  for (const chain of limbChains) {
    limbJointSet.add(chain.root);
    limbJointSet.add(chain.mid);
    limbJointSet.add(chain.end);
  }

  // Default root position
  const hipsPos = positions.get(joints[0].name);
  const rootPosition: Vec3 = hipsPos ?? { x: 0, y: 0, z: 0 };

  // Pass 1: Process non-limb joints with direction-based IK
  for (let i = 0; i < joints.length; i++) {
    if (limbJointSet.has(i)) continue; // Skip limb joints for now

    const joint = joints[i];
    const children = getChildren(skeleton, i);

    if (children.length === 0) {
      localRotations[i] = IDENTITY;
      worldRotations[i] = joint.parent >= 0
        ? multiply(worldRotations[joint.parent], IDENTITY)
        : IDENTITY;
      continue;
    }

    const thisPos = positions.get(joint.name);
    if (!thisPos) {
      localRotations[i] = prevRotations?.[i]
        ? slerp(prevRotations[i], IDENTITY, 0.1)
        : IDENTITY;
      worldRotations[i] = joint.parent >= 0
        ? multiply(worldRotations[joint.parent], localRotations[i])
        : localRotations[i];
      continue;
    }

    let targetDir = computeAverageBoneDir(thisPos, children, joints, positions);

    if (!targetDir) {
      localRotations[i] = prevRotations?.[i]
        ? slerp(prevRotations[i], IDENTITY, 0.1)
        : IDENTITY;
      worldRotations[i] = joint.parent >= 0
        ? multiply(worldRotations[joint.parent], localRotations[i])
        : localRotations[i];
      continue;
    }

    const restDir = computeRestBoneDir(children, joints);
    if (!restDir) {
      localRotations[i] = IDENTITY;
      worldRotations[i] = joint.parent >= 0
        ? multiply(worldRotations[joint.parent], IDENTITY)
        : IDENTITY;
      continue;
    }

    const worldRot = fromUnitVectors(restDir, targetDir);

    if (joint.parent >= 0) {
      const parentWorldInv = inverse(worldRotations[joint.parent]);
      localRotations[i] = normQuat(multiply(parentWorldInv, worldRot));
    } else {
      localRotations[i] = normQuat(worldRot);
    }

    worldRotations[i] = joint.parent >= 0
      ? normQuat(multiply(worldRotations[joint.parent], localRotations[i]))
      : localRotations[i];
  }

  // Pass 2: Solve limb chains with two-bone IK
  for (const chain of limbChains) {
    const rootJoint = joints[chain.root];
    const midJoint = joints[chain.mid];
    const endJoint = joints[chain.end];

    const rootPos = positions.get(rootJoint.name);
    const endPos = positions.get(endJoint.name);

    if (!rootPos || !endPos) {
      // Missing positions — decay toward rest
      for (const idx of [chain.root, chain.mid, chain.end]) {
        localRotations[idx] = prevRotations?.[idx]
          ? slerp(prevRotations[idx], IDENTITY, 0.1)
          : IDENTITY;
        worldRotations[idx] = joints[idx].parent >= 0
          ? normQuat(multiply(worldRotations[joints[idx].parent], localRotations[idx]))
          : localRotations[idx];
      }
      continue;
    }

    // Rest-pose bone directions
    const restDirUpper = normVec(midJoint.offset);
    const restDirLower = normVec(endJoint.offset);

    // Derive pole vector from detected mid-joint position (elbows only).
    //
    // Arms: The detected elbow position reveals which direction the arm bends,
    // which varies hugely (forward, backward, outward). Using the actual detection
    // is far more accurate than a fixed anatomical prior.
    //
    // Legs: Knees always bend forward, but from a 2D front view the forward
    // bend is invisible (it's in the depth axis). The detected knee position's
    // perpendicular component is mostly sideways noise, so we keep the
    // anatomical prior (knees forward = +Z).
    const isArm = chain.root === skeleton.nameToIndex.get(JointName.LEFT_ARM) ||
                  chain.root === skeleton.nameToIndex.get(JointName.RIGHT_ARM);

    let poleVec = chain.poleVector;
    if (isArm) {
      const detectedMidPos = positions.get(midJoint.name);
      if (detectedMidPos) {
        const ac = sub(endPos, rootPos);
        const acLen = vecLen(ac);
        if (acLen > 0.01) {
          const acDir = normVec(ac);
          const am = sub(detectedMidPos, rootPos);
          const along = dot(am, acDir);
          const perp = sub(am, scale(acDir, along));
          if (vecLen(perp) > 0.5) {
            poleVec = normVec(perp);
          }
        }
      }
    }

    const { rootRot, midRot } = solveTwoBoneIK(
      rootPos,
      endPos,
      chain.upperLength,
      chain.lowerLength,
      poleVec,
      restDirUpper,
      restDirLower,
    );

    // Convert two-bone world rotations to local space
    const parentWorldRot = rootJoint.parent >= 0
      ? worldRotations[rootJoint.parent]
      : IDENTITY;

    // Root joint local rotation
    localRotations[chain.root] = normQuat(multiply(inverse(parentWorldRot), rootRot));
    worldRotations[chain.root] = normQuat(multiply(parentWorldRot, localRotations[chain.root]));

    // Mid joint: midRot is already in local space (relative to root rotation)
    localRotations[chain.mid] = normQuat(midRot);
    worldRotations[chain.mid] = normQuat(multiply(worldRotations[chain.root], localRotations[chain.mid]));

    // Forearm twist from hand landmarks (arms only, not legs)
    const isLeftArm = chain.mid === skeleton.nameToIndex.get(JointName.LEFT_FOREARM);
    const isRightArm = chain.mid === skeleton.nameToIndex.get(JointName.RIGHT_FOREARM);
    if (isLeftArm || isRightArm) {
      const midWorldRot = worldRotations[chain.mid];
      const forearmDir = rotateVec(midWorldRot, normVec(joints[chain.end].offset));
      const twist = computeForearmTwist(frame, forearmDir, isLeftArm === true);

      if (twist) {
        // Apply twist to the mid (forearm) joint rotation
        localRotations[chain.mid] = normQuat(multiply(localRotations[chain.mid], twist));
        worldRotations[chain.mid] = normQuat(multiply(worldRotations[chain.root], localRotations[chain.mid]));
      } else if (prevRotations) {
        // No hand data — decay previous twist toward identity
        const prevMidRot = prevRotations[chain.mid];
        const { twist: prevTwist } = swingTwist(prevMidRot, normVec(joints[chain.end].offset));
        const decayedTwist = slerp(prevTwist, IDENTITY, 1 - TWIST_DECAY);
        // Only apply if the decayed twist is non-trivial
        if (angleBetween(decayedTwist, IDENTITY) > 0.01) {
          localRotations[chain.mid] = normQuat(multiply(localRotations[chain.mid], decayedTwist));
          worldRotations[chain.mid] = normQuat(multiply(worldRotations[chain.root], localRotations[chain.mid]));
        }
      }
    }

    // End joint (leaf): identity
    localRotations[chain.end] = IDENTITY;
    worldRotations[chain.end] = normQuat(multiply(worldRotations[chain.mid], IDENTITY));
  }

  return { rootPosition, localRotations };
}

/**
 * Compute average bone direction from parent to children in world space.
 */
function computeAverageBoneDir(
  parentPos: Vec3,
  children: number[],
  joints: Joint[],
  positions: Map<string, Vec3>,
): Vec3 | null {
  let sumDir: Vec3 = { x: 0, y: 0, z: 0 };
  let count = 0;

  for (const childIdx of children) {
    const childPos = positions.get(joints[childIdx].name);
    if (!childPos) continue;

    const dir = sub(childPos, parentPos);
    if (vecLen(dir) < 0.01) continue;

    const n = normVec(dir);
    sumDir = add(sumDir, n);
    count++;
  }

  if (count === 0) return null;
  const avg = scale(sumDir, 1 / count);
  return vecLen(avg) < 1e-6 ? null : normVec(avg);
}

/**
 * Compute the rest-pose bone direction from a joint to its children.
 * Uses the offset vector of the first child.
 */
function computeRestBoneDir(children: number[], joints: Joint[]): Vec3 | null {
  if (children.length === 0) return null;

  const offset = joints[children[0]].offset;
  const len = vecLen(offset);
  if (len < 0.01) return null;

  return normVec(offset);
}

/**
 * Batch solve IK for all frames. Passes previous rotations to enable
 * decay-toward-rest for occluded joints.
 */
export function solveAllFrames(
  frames: FramePose[],
  skeleton: SkeletonDef,
): IKFrame[] {
  const results: IKFrame[] = [];
  let prevRotations: Quat[] | undefined;

  for (const frame of frames) {
    const result = solveIK(frame, skeleton, prevRotations);
    results.push(result);
    prevRotations = result.localRotations;
  }

  return results;
}
