/**
 * Minimal BVH parser for the in-browser 3D viewer.
 *
 * It understands the HIERARCHY + MOTION structure produced by
 * @mocap-ts/core (ROOT/JOINT, CHANNELS 6 or 3, ZXY euler order, MOTION).
 * It is intentionally tolerant of the few quirks of our own writer so the
 * viewer never needs a third-party loader.
 */

export interface BvhJoint {
  name: string;
  offset: [number, number, number];
  channels: number; // 6 for root, 3 otherwise
  parent: number;
  children: number[];
}

export interface BvhData {
  joints: BvhJoint[];
  /** Channel order across all joints (so frame[i] maps cleanly). */
  channelCount: number;
  frameTime: number;
  frames: number[][];
}

/** Per-frame resolved rotations + root translation, ready for a skeleton. */
export interface BvhFrame {
  rootTranslation: [number, number, number];
  /** Euler angles (radians, ZXY) per joint index. */
  rotations: [number, number, number][];
}

export function parseBVH(text: string): BvhData {
  const lines = text.split(/\r?\n/);
  let i = 0;
  const joints: BvhJoint[] = [];
  const stack: number[] = [];

  // --- HIERARCHY ---
  // Skip until HIERARCHY
  while (i < lines.length && !lines[i].trim().startsWith('HIERARCHY')) i++;
  i++;

  let channelCount = 0;

  const parseJoint = (depth: number): void => {
    // Find the ROOT/JOINT line.
    while (i < lines.length) {
      const line = lines[i].trim();
      if (line === '' || line === '{') { i++; continue; }
      if (line.startsWith('ROOT ') || line.startsWith('JOINT ') || line.startsWith('End Site')) break;
      i++;
    }
    if (i >= lines.length) return;

    const header = lines[i].trim();
    i++;

    let jointIndex: number;
    let name: string;
    if (header.startsWith('End Site')) {
      // End site is an unnamed leaf — represent it but don't add channels.
      name = 'EndSite';
      jointIndex = joints.length;
      joints.push({ name, offset: [0, 0, 0], channels: 0, parent: stack[stack.length - 1] ?? -1, children: [] });
    } else {
      name = header.replace(/^(ROOT|JOINT)\s+/, '');
      jointIndex = joints.length;
      const parent = stack[stack.length - 1] ?? -1;
      joints.push({ name, offset: [0, 0, 0], channels: 0, parent, children: [] });
      if (parent >= 0) joints[parent].children.push(jointIndex);
    }

    // Expect {
    while (i < lines.length && lines[i].trim() !== '{') i++;
    i++; // consume {

    while (i < lines.length) {
      const line = lines[i].trim();
      if (line === '') { i++; continue; }
      if (line === '}') { i++; break; }
      if (line.startsWith('OFFSET')) {
        const [, x, y, z] = line.split(/\s+/);
        joints[jointIndex].offset = [parseFloat(x), parseFloat(y), parseFloat(z)];
        i++;
      } else if (line.startsWith('CHANNELS')) {
        const parts = line.split(/\s+/);
        const n = parseInt(parts[1], 10);
        joints[jointIndex].channels = n;
        channelCount += n;
        i++;
      } else if (line.startsWith('ROOT ') || line.startsWith('JOINT ') || line.startsWith('End Site')) {
        // Recurse into child.
        stack.push(jointIndex);
        parseJoint(depth + 1);
        stack.pop();
      } else {
        i++;
      }
    }
  };

  parseJoint(0);

  // --- MOTION ---
  let frameTime = 0;
  let frameStart = 0;
  while (i < lines.length) {
    const line = lines[i].trim();
    if (line.startsWith('Frames:')) { frameStart = i + 2; i++; continue; }
    if (line.startsWith('Frame Time:')) { frameTime = parseFloat(line.split(':')[1].trim()); i++; continue; }
    i++;
  }

  const frames: number[][] = [];
  for (let f = frameStart; f < lines.length; f++) {
    const line = lines[f].trim();
    if (!line) continue;
    const vals = line.split(/\s+/).map(Number);
    if (vals.length === channelCount && vals.every(v => Number.isFinite(v))) {
      frames.push(vals);
    }
  }

  return { joints, channelCount, frameTime, frames };
}

/** Map a flat frame of channel values to per-joint translations/rotations. */
export function resolveFrame(bvh: BvhData, frameIndex: number): BvhFrame {
  const frame = bvh.frames[frameIndex] ?? [];
  const rootTranslation: [number, number, number] = [0, 0, 0];
  const rotations: [number, number, number][] = [];
  let cursor = 0;
  for (const joint of bvh.joints) {
    if (joint.channels === 6) {
      rootTranslation[0] = frame[cursor] ?? 0;
      rootTranslation[1] = frame[cursor + 1] ?? 0;
      rootTranslation[2] = frame[cursor + 2] ?? 0;
      // ZXY euler in degrees → radians
      rotations.push([
        (frame[cursor + 3] ?? 0) * Math.PI / 180,
        (frame[cursor + 4] ?? 0) * Math.PI / 180,
        (frame[cursor + 5] ?? 0) * Math.PI / 180,
      ]);
      cursor += 6;
    } else if (joint.channels === 3) {
      rotations.push([
        (frame[cursor] ?? 0) * Math.PI / 180,
        (frame[cursor + 1] ?? 0) * Math.PI / 180,
        (frame[cursor + 2] ?? 0) * Math.PI / 180,
      ]);
      cursor += 3;
    } else {
      rotations.push([0, 0, 0]);
    }
  }
  return { rootTranslation, rotations };
}
