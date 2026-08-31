import type { Vec3 } from '../math/vector3.js';
import { length as vecLen } from '../math/vector3.js';

/**
 * Joint definition in the skeleton hierarchy.
 */
export interface Joint {
  name: string;
  /** Index of parent joint (-1 for root) */
  parent: number;
  /** Offset from parent in rest pose (T-pose), in centimeters */
  offset: Vec3;
  /** Number of channels: 6 for root (pos+rot), 3 for others (rot only) */
  channels: 3 | 6;
  /** Bone length from parent to this joint (computed from offset magnitude) */
  boneLength: number;
}

/**
 * A two-bone IK chain: root → mid → end (e.g. shoulder → elbow → wrist).
 */
export interface LimbChain {
  /** Joint index of the chain root (e.g. LeftArm) */
  root: number;
  /** Joint index of the mid joint (e.g. LeftForeArm) */
  mid: number;
  /** Joint index of the chain end (e.g. LeftHand) */
  end: number;
  /** Upper bone length (root → mid) */
  upperLength: number;
  /** Lower bone length (mid → end) */
  lowerLength: number;
  /** Default pole vector direction (world space) for elbow/knee preferred bend */
  poleVector: Vec3;
}

/**
 * Complete skeleton definition.
 */
export interface SkeletonDef {
  joints: Joint[];
  /** Map joint name to index for quick lookup */
  nameToIndex: Map<string, number>;
  /** Two-bone IK chains for limbs */
  limbChains: LimbChain[];
}

/**
 * Standard joint names used in BVH humanoid skeletons.
 */
export const JointName = {
  HIPS: 'Hips',
  SPINE: 'Spine',
  SPINE1: 'Spine1',
  SPINE2: 'Spine2',
  NECK: 'Neck',
  HEAD: 'Head',
  LEFT_SHOULDER: 'LeftShoulder',
  LEFT_ARM: 'LeftArm',
  LEFT_FOREARM: 'LeftForeArm',
  LEFT_HAND: 'LeftHand',
  RIGHT_SHOULDER: 'RightShoulder',
  RIGHT_ARM: 'RightArm',
  RIGHT_FOREARM: 'RightForeArm',
  RIGHT_HAND: 'RightHand',
  LEFT_UPLEG: 'LeftUpLeg',
  LEFT_LEG: 'LeftLeg',
  LEFT_FOOT: 'LeftFoot',
  RIGHT_UPLEG: 'RightUpLeg',
  RIGHT_LEG: 'RightLeg',
  RIGHT_FOOT: 'RightFoot',
} as const;

/**
 * 20-joint humanoid skeleton in T-pose.
 * Offsets are approximate, in centimeters, for an average adult (~170cm).
 *
 * Hierarchy:
 *   Hips
 *   ├── Spine
 *   │   └── Spine1
 *   │       └── Spine2
 *   │           ├── Neck
 *   │           │   └── Head
 *   │           ├── LeftShoulder
 *   │           │   └── LeftArm
 *   │           │       └── LeftForeArm
 *   │           │           └── LeftHand
 *   │           └── RightShoulder
 *   │               └── RightArm
 *   │                   └── RightForeArm
 *   │                       └── RightHand
 *   ├── LeftUpLeg
 *   │   └── LeftLeg
 *   │       └── LeftFoot
 *   └── RightUpLeg
 *       └── RightLeg
 *           └── RightFoot
 */
function buildJoints(): Joint[] {
  const j: Joint[] = [];
  const add = (name: string, parent: number, offset: Vec3, channels: 3 | 6 = 3) => {
    j.push({ name, parent, offset, channels, boneLength: vecLen(offset) });
    return j.length - 1;
  };

  //                   name              parent   offset { x, y, z }
  const hips     = add(JointName.HIPS,           -1, { x: 0,   y: 0,    z: 0   }, 6); // root

  // Spine chain
  const spine    = add(JointName.SPINE,           hips,  { x: 0,   y: 10,   z: 0   });
  const spine1   = add(JointName.SPINE1,          spine, { x: 0,   y: 10,   z: 0   });
  const spine2   = add(JointName.SPINE2,          spine1,{ x: 0,   y: 10,   z: 0   });

  // Head chain
  const neck     = add(JointName.NECK,            spine2,{ x: 0,   y: 5,    z: 0   });
  /*head*/         add(JointName.HEAD,            neck,  { x: 0,   y: 10,   z: 0   });

  // Left arm chain (T-pose: arms extended along +X)
  const lShldr   = add(JointName.LEFT_SHOULDER,   spine2,{ x: 5,   y: 2,    z: 0   });
  const lArm     = add(JointName.LEFT_ARM,        lShldr,{ x: 10,  y: 0,    z: 0   });
  const lForeArm = add(JointName.LEFT_FOREARM,    lArm,  { x: 25,  y: 0,    z: 0   });
  /*lHand*/        add(JointName.LEFT_HAND,       lForeArm,{ x: 25, y: 0,   z: 0   });

  // Right arm chain (T-pose: arms extended along -X)
  const rShldr   = add(JointName.RIGHT_SHOULDER,  spine2,{ x: -5,  y: 2,    z: 0   });
  const rArm     = add(JointName.RIGHT_ARM,       rShldr,{ x: -10, y: 0,    z: 0   });
  const rForeArm = add(JointName.RIGHT_FOREARM,   rArm,  { x: -25, y: 0,    z: 0   });
  /*rHand*/        add(JointName.RIGHT_HAND,      rForeArm,{ x: -25,y: 0,   z: 0   });

  // Left leg chain
  const lUpLeg   = add(JointName.LEFT_UPLEG,      hips,  { x: 10,  y: -5,   z: 0   });
  const lLeg     = add(JointName.LEFT_LEG,        lUpLeg,{ x: 0,   y: -45,  z: 0   });
  /*lFoot*/        add(JointName.LEFT_FOOT,       lLeg,  { x: 0,   y: -45,  z: 0   });

  // Right leg chain
  const rUpLeg   = add(JointName.RIGHT_UPLEG,     hips,  { x: -10, y: -5,   z: 0   });
  const rLeg     = add(JointName.RIGHT_LEG,       rUpLeg,{ x: 0,   y: -45,  z: 0   });
  /*rFoot*/        add(JointName.RIGHT_FOOT,      rLeg,  { x: 0,   y: -45,  z: 0   });

  return j;
}

/**
 * Build the limb chains for two-bone IK.
 */
function buildLimbChains(joints: Joint[], nameToIndex: Map<string, number>): LimbChain[] {
  const idx = (name: string) => nameToIndex.get(name)!;

  return [
    // Left arm: shoulder → elbow → wrist
    {
      root: idx(JointName.LEFT_ARM),
      mid: idx(JointName.LEFT_FOREARM),
      end: idx(JointName.LEFT_HAND),
      upperLength: joints[idx(JointName.LEFT_FOREARM)].boneLength,  // 25
      lowerLength: joints[idx(JointName.LEFT_HAND)].boneLength,     // 25
      poleVector: { x: 0.3, y: 0, z: -1 },  // elbows bend backward/outward
    },
    // Right arm: shoulder → elbow → wrist
    {
      root: idx(JointName.RIGHT_ARM),
      mid: idx(JointName.RIGHT_FOREARM),
      end: idx(JointName.RIGHT_HAND),
      upperLength: joints[idx(JointName.RIGHT_FOREARM)].boneLength, // 25
      lowerLength: joints[idx(JointName.RIGHT_HAND)].boneLength,    // 25
      poleVector: { x: -0.3, y: 0, z: -1 },  // elbows bend backward/outward
    },
    // Left leg: hip → knee → ankle
    {
      root: idx(JointName.LEFT_UPLEG),
      mid: idx(JointName.LEFT_LEG),
      end: idx(JointName.LEFT_FOOT),
      upperLength: joints[idx(JointName.LEFT_LEG)].boneLength,   // 45
      lowerLength: joints[idx(JointName.LEFT_FOOT)].boneLength,  // 45
      poleVector: { x: 0, y: 0, z: 1 },  // knees bend forward
    },
    // Right leg: hip → knee → ankle
    {
      root: idx(JointName.RIGHT_UPLEG),
      mid: idx(JointName.RIGHT_LEG),
      end: idx(JointName.RIGHT_FOOT),
      upperLength: joints[idx(JointName.RIGHT_LEG)].boneLength,  // 45
      lowerLength: joints[idx(JointName.RIGHT_FOOT)].boneLength, // 45
      poleVector: { x: 0, y: 0, z: 1 },  // knees bend forward
    },
  ];
}

/**
 * Create the standard humanoid skeleton definition.
 */
export function createSkeleton(): SkeletonDef {
  const joints = buildJoints();
  const nameToIndex = new Map<string, number>();
  for (let i = 0; i < joints.length; i++) {
    nameToIndex.set(joints[i].name, i);
  }
  const limbChains = buildLimbChains(joints, nameToIndex);
  return { joints, nameToIndex, limbChains };
}

/**
 * Get children of a joint.
 */
export function getChildren(skeleton: SkeletonDef, jointIndex: number): number[] {
  return skeleton.joints
    .map((j, i) => j.parent === jointIndex ? i : -1)
    .filter(i => i !== -1);
}
