import * as THREE from 'three';
import type { BvhData, BvhFrame } from './bvh-parser';

/**
 * Exact BVH retargeting math, shared by the procedural and glTF character
 * viewers. Mirrors the convention of @mocap-ts/core's BVH writer:
 *
 *   - channel order per joint: root 6 (Xpos Ypos Zpos Zrot Xrot Yrot),
 *     others 3 (Zrot Xrot Yrot)
 *   - euler order: ZXY intrinsic (q = qz * qx * qy, applied to a column
 *     vector as R = Rz · Rx · Ry)
 *   - each joint's local transform is T(offset) · R(localEuler)
 *   - world(child) = world(parent) · local(child)
 *
 * The viewer previously approximated this with THREE.Euler (XYZ extrinsic),
 * which drifts on large rotations. This module builds the exact per-joint
 * quaternion from the ZXY-intrinsic formula (the same one as core's
 * fromEulerZXY) and composes it down the parent chain.
 */

export interface JointTransform {
  /** World-space rotation (quaternion). */
  worldQuat: THREE.Quaternion;
  /** World-space position. */
  worldPos: THREE.Vector3;
  /** Local rotation relative to parent (quaternion). */
  localQuat: THREE.Quaternion;
}

/**
 * Resolve per-joint world transforms for one BVH frame.
 *
 * @param bvh       parsed BVH
 * @param frame     resolved frame (root translation + per-joint [z,x,y] radians)
 * @param skeletonScale optional uniform scale (BVH units → scene units); default 1
 * @returns transforms indexed by joint order
 */
export function resolveFrameTransforms(
  bvh: BvhData,
  frame: BvhFrame,
  skeletonScale = 1,
): JointTransform[] {
  const out: JointTransform[] = [];
  for (let i = 0; i < bvh.joints.length; i++) {
    const joint = bvh.joints[i];
    const [z, x, y] = frame.rotations[i] ?? [0, 0, 0];
    const localQuat = zxyIntrinsicQuat(z, x, y);

    if (joint.parent < 0) {
      // Root: world rotation = local rotation; world pos = root translation.
      const worldQuat = localQuat.clone();
      const worldPos = new THREE.Vector3(
        frame.rootTranslation[0],
        frame.rootTranslation[1],
        frame.rootTranslation[2],
      ).multiplyScalar(skeletonScale);
      out.push({ worldQuat, worldPos, localQuat: localQuat.clone() });
    } else {
      const parent = out[joint.parent];
      // World rotation = parent world rotation · local rotation.
      const worldQuat = parent.worldQuat.clone().multiply(localQuat);
      // World position = parent world position + (parent world rotation · offset).
      const offsetVec = new THREE.Vector3(
        joint.offset[0],
        joint.offset[1],
        joint.offset[2],
      ).multiplyScalar(skeletonScale);
      const worldPos = parent.worldPos.clone().add(
        offsetVec.applyQuaternion(parent.worldQuat),
      );
      out.push({ worldQuat, worldPos, localQuat: localQuat.clone() });
    }
  }
  return out;
}

/**
 * Build the ZXY-intrinsic quaternion from (z, x, y) euler angles in radians.
 *
 * q_intrinsic(ZXY) = qz · qx · qy  (applied to v as Rz · Rx · Ry)
 *
 * This matches @mocap-ts/core's `fromEulerZXY` exactly, so the viewer's
 * rotations are the inverse of the writer's, round-tripping cleanly.
 */
export function zxyIntrinsicQuat(z: number, x: number, y: number): THREE.Quaternion {
  const cx = Math.cos(x * 0.5), sx = Math.sin(x * 0.5);
  const cy = Math.cos(y * 0.5), sy = Math.sin(y * 0.5);
  const cz = Math.cos(z * 0.5), sz = Math.sin(z * 0.5);
  // qz · qx · qy
  const qz = new THREE.Quaternion(0, 0, sz, cz);
  const qx = new THREE.Quaternion(sx, 0, 0, cx);
  const qy = new THREE.Quaternion(0, sy, 0, cy);
  return qz.multiply(qx).multiply(qy);
}

/**
 * Apply resolved transforms to a procedural character whose THREE.Object3D
 * hierarchy mirrors the BVH joint names.
 *
 * Each named joint's local quaternion is set directly (its parent link in
 * the object3D graph already encodes the offset translation).
 */
export function applyToLocalHierarchy(
  bvh: BvhData,
  transforms: JointTransform[],
  root: THREE.Object3D,
): void {
  for (let i = 0; i < bvh.joints.length; i++) {
    const joint = bvh.joints[i];
    if (joint.channels === 0) continue; // end site
    const obj = root.getObjectByName(joint.name);
    if (!obj) continue;
    if (joint.parent < 0) {
      // Root: position + rotation, relative to the character group's origin.
      obj.position.copy(transforms[i].worldPos);
      obj.quaternion.copy(transforms[i].worldQuat);
    } else {
      // Non-root: set local rotation only; position is the rest offset.
      obj.quaternion.copy(transforms[i].localQuat);
    }
  }
}

/**
 * Apply resolved transforms to a glTF skinned mesh by name-mapping BVH joints
 * to the rig's bones and writing world transforms to each bone.
 *
 * The bone's own rest offset is preserved; we overwrite world position +
 * rotation and let three's `Skeleton` recompute. This is a simple
 * name-based retarget — it assumes the glTF rig uses Mixamo-style bone names
 * matching the BVH (Hips, Spine, LeftArm, ...). When names differ, a
 * mapping table can be passed; see `mapBoneNames`.
 */
export function applyToSkinnedMesh(
  bvh: BvhData,
  transforms: JointTransform[],
  skeleton: THREE.Skeleton,
  nameMap?: Map<string, string>,
): void {
  for (let i = 0; i < bvh.joints.length; i++) {
    const joint = bvh.joints[i];
    const boneName = nameMap?.get(joint.name) ?? joint.name;
    const bone = skeleton.getBoneByName(boneName);
    if (!bone) continue;
    bone.quaternion.copy(transforms[i].localQuat);
    if (joint.parent < 0) {
      // Root bone also takes the world translation.
      bone.position.set(
        transforms[i].worldPos.x,
        transforms[i].worldPos.y,
        transforms[i].worldPos.z,
      );
    }
  }
  skeleton.calculateInverses();
}

/**
 * Default BVH→Mixamo bone-name mapping for glTF rigs that use the
 * Mixamo convention. Our BVH already uses Mixamo names (Hips, Spine, ...),
 * so most map 1:1; this table exists for the few rigs that differ.
 */
export const MIXAMO_NAME_ALIASES: Record<string, string[]> = {
  Hips: ['Hips', 'hip', 'pelvis', 'root'],
  Spine: ['Spine', 'spine01', 'spine_lower'],
  Spine1: ['Spine1', 'spine02', 'spine_middle'],
  Spine2: ['Spine2', 'spine03', 'chest', 'spine_upper'],
  Neck: ['Neck', 'neck'],
  Head: ['Head', 'head'],
  LeftShoulder: ['LeftShoulder', 'leftShoulder', 'clavicle_L'],
  LeftArm: ['LeftArm', 'leftArm', 'upperarm_L'],
  LeftForeArm: ['LeftForeArm', 'leftForeArm', 'forearm_L', 'lowerarm_L'],
  LeftHand: ['LeftHand', 'leftHand', 'hand_L'],
  RightShoulder: ['RightShoulder', 'rightShoulder', 'clavicle_R'],
  RightArm: ['RightArm', 'rightArm', 'upperarm_R'],
  RightForeArm: ['RightForeArm', 'rightForeArm', 'forearm_R', 'lowerarm_R'],
  RightHand: ['RightHand', 'rightHand', 'hand_R'],
  LeftUpLeg: ['LeftUpLeg', 'leftUpLeg', 'thigh_L', 'upperleg_L'],
  LeftLeg: ['LeftLeg', 'leftLeg', 'calf_L', 'lowerleg_L'],
  LeftFoot: ['LeftFoot', 'leftFoot', 'foot_L'],
  RightUpLeg: ['RightUpLeg', 'rightUpLeg', 'thigh_R', 'upperleg_R'],
  RightLeg: ['RightLeg', 'rightLeg', 'calf_R', 'lowerleg_R'],
  RightFoot: ['RightFoot', 'rightFoot', 'foot_R'],
};

/** Build a BVH-name → rig-bone-name lookup against a real skeleton. */
export function buildNameMap(skeleton: THREE.Skeleton): Map<string, string> {
  const boneNames = new Set(skeleton.bones.map(b => b.name));
  const map = new Map<string, string>();
  for (const [bvhName, aliases] of Object.entries(MIXAMO_NAME_ALIASES)) {
    for (const alias of aliases) {
      if (boneNames.has(alias)) {
        map.set(bvhName, alias);
        break;
      }
    }
  }
  return map;
}
