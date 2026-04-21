import type { SkeletonDef, Joint } from '../skeleton/hierarchy.js';
import { getChildren } from '../skeleton/hierarchy.js';
import type { IKFrame } from '../skeleton/ik.js';
import { toEulerZXY } from '../math/quaternion.js';

const RAD2DEG = 180 / Math.PI;

/**
 * Write a BVH animation file from skeleton definition and per-frame IK data.
 *
 * BVH format:
 *   HIERARCHY section: recursive joint tree with offsets and channel specs
 *   MOTION section: per-frame channel values (positions + rotations)
 *
 * Channel order per joint:
 *   Root (6 channels): Xposition Yposition Zposition Zrotation Xrotation Yrotation
 *   Others (3 channels): Zrotation Xrotation Yrotation
 *
 * Euler order: ZXY (intrinsic) — standard for humanoid BVH.
 */
export function writeBVH(
  skeleton: SkeletonDef,
  frames: IKFrame[],
  fps: number,
): string {
  const lines: string[] = [];

  // --- HIERARCHY ---
  lines.push('HIERARCHY');
  writeJoint(skeleton, 0, 0, lines);

  // --- MOTION ---
  lines.push('MOTION');
  lines.push(`Frames: ${frames.length}`);
  lines.push(`Frame Time: ${(1 / fps).toFixed(6)}`);

  for (const frame of frames) {
    const values: number[] = [];
    collectFrameChannels(skeleton, frame, 0, values);
    lines.push(values.map(v => v.toFixed(4)).join(' '));
  }

  return lines.join('\n') + '\n';
}

/**
 * Write a joint and its children recursively into the HIERARCHY section.
 */
function writeJoint(
  skeleton: SkeletonDef,
  jointIndex: number,
  depth: number,
  lines: string[],
): void {
  const joint = skeleton.joints[jointIndex];
  const indent = '  '.repeat(depth);
  const children = getChildren(skeleton, jointIndex);

  // Root vs regular joint
  if (joint.parent < 0) {
    lines.push(`${indent}ROOT ${joint.name}`);
  } else {
    lines.push(`${indent}JOINT ${joint.name}`);
  }

  lines.push(`${indent}{`);

  // Offset
  lines.push(`${indent}  OFFSET ${joint.offset.x.toFixed(4)} ${joint.offset.y.toFixed(4)} ${joint.offset.z.toFixed(4)}`);

  // Channels
  if (joint.channels === 6) {
    lines.push(`${indent}  CHANNELS 6 Xposition Yposition Zposition Zrotation Xrotation Yrotation`);
  } else {
    lines.push(`${indent}  CHANNELS 3 Zrotation Xrotation Yrotation`);
  }

  if (children.length === 0) {
    // End site (leaf node) — add a pseudo-joint for BVH parsers
    lines.push(`${indent}  End Site`);
    lines.push(`${indent}  {`);
    lines.push(`${indent}    OFFSET 0.0000 0.0000 0.0000`);
    lines.push(`${indent}  }`);
  } else {
    for (const child of children) {
      writeJoint(skeleton, child, depth + 1, lines);
    }
  }

  lines.push(`${indent}}`);
}

/**
 * Collect channel values for a single frame, in hierarchy traversal order.
 */
function collectFrameChannels(
  skeleton: SkeletonDef,
  frame: IKFrame,
  jointIndex: number,
  values: number[],
): void {
  const joint = skeleton.joints[jointIndex];
  const rotation = frame.localRotations[jointIndex];
  const euler = toEulerZXY(rotation);

  if (joint.channels === 6) {
    // Root: position + rotation
    values.push(frame.rootPosition.x);
    values.push(frame.rootPosition.y);
    values.push(frame.rootPosition.z);
  }

  // Rotation in degrees, ZXY order
  values.push(euler.z * RAD2DEG);
  values.push(euler.x * RAD2DEG);
  values.push(euler.y * RAD2DEG);

  // Recurse children in the same order as HIERARCHY
  const children = getChildren(skeleton, jointIndex);
  for (const child of children) {
    collectFrameChannels(skeleton, frame, child, values);
  }
}

/**
 * Parse a BVH string to extract basic metadata (for testing roundtrips).
 */
export function parseBVHMeta(bvh: string): {
  jointCount: number;
  frameCount: number;
  frameTime: number;
  channelCount: number;
} {
  const lines = bvh.split('\n').map(l => l.trim());

  let jointCount = 0;
  let channelCount = 0;
  let frameCount = 0;
  let frameTime = 0;

  for (const line of lines) {
    if (line.startsWith('ROOT ') || line.startsWith('JOINT ')) {
      jointCount++;
    }
    if (line.startsWith('CHANNELS ')) {
      channelCount += parseInt(line.split(' ')[1], 10);
    }
    if (line.startsWith('Frames:')) {
      frameCount = parseInt(line.split(':')[1].trim(), 10);
    }
    if (line.startsWith('Frame Time:')) {
      frameTime = parseFloat(line.split(':')[1].trim());
    }
  }

  return { jointCount, frameCount, frameTime, channelCount };
}
