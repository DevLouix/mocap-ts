import { type Vec3, normalize as normalizeVec, cross, dot, length as vecLength } from './vector3.js';

export interface Quat {
  x: number;
  y: number;
  z: number;
  w: number;
}

export function quat(x: number, y: number, z: number, w: number): Quat {
  return { x, y, z, w };
}

export const IDENTITY: Quat = { x: 0, y: 0, z: 0, w: 1 };

export function multiply(a: Quat, b: Quat): Quat {
  return {
    x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
    y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
    z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
    w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
  };
}

export function conjugate(q: Quat): Quat {
  return { x: -q.x, y: -q.y, z: -q.z, w: q.w };
}

export function lengthSq(q: Quat): number {
  return q.x * q.x + q.y * q.y + q.z * q.z + q.w * q.w;
}

export function length(q: Quat): number {
  return Math.sqrt(lengthSq(q));
}

export function normalize(q: Quat): Quat {
  const len = length(q);
  if (len < 1e-10) return IDENTITY;
  return { x: q.x / len, y: q.y / len, z: q.z / len, w: q.w / len };
}

export function inverse(q: Quat): Quat {
  const lenSq = lengthSq(q);
  if (lenSq < 1e-10) return IDENTITY;
  return {
    x: -q.x / lenSq,
    y: -q.y / lenSq,
    z: -q.z / lenSq,
    w: q.w / lenSq,
  };
}

export function dot_q(a: Quat, b: Quat): number {
  return a.x * b.x + a.y * b.y + a.z * b.z + a.w * b.w;
}

export function slerp(a: Quat, b: Quat, t: number): Quat {
  let bx = b.x, by = b.y, bz = b.z, bw = b.w;

  let cosHalfTheta = a.x * bx + a.y * by + a.z * bz + a.w * bw;

  // Take shortest path
  if (cosHalfTheta < 0) {
    bx = -bx; by = -by; bz = -bz; bw = -bw;
    cosHalfTheta = -cosHalfTheta;
  }

  // Nearly identical — linear interpolation to avoid division by zero
  if (cosHalfTheta > 0.9995) {
    return normalize({
      x: a.x + (bx - a.x) * t,
      y: a.y + (by - a.y) * t,
      z: a.z + (bz - a.z) * t,
      w: a.w + (bw - a.w) * t,
    });
  }

  const halfTheta = Math.acos(cosHalfTheta);
  const sinHalfTheta = Math.sin(halfTheta);
  const ratioA = Math.sin((1 - t) * halfTheta) / sinHalfTheta;
  const ratioB = Math.sin(t * halfTheta) / sinHalfTheta;

  return {
    x: a.x * ratioA + bx * ratioB,
    y: a.y * ratioA + by * ratioB,
    z: a.z * ratioA + bz * ratioB,
    w: a.w * ratioA + bw * ratioB,
  };
}

export function fromAxisAngle(axis: Vec3, angle: number): Quat {
  const half = angle * 0.5;
  const s = Math.sin(half);
  const n = normalizeVec(axis);
  return { x: n.x * s, y: n.y * s, z: n.z * s, w: Math.cos(half) };
}

/**
 * Rotation that takes vector `from` to vector `to`.
 * Both should be unit vectors.
 */
export function fromUnitVectors(from: Vec3, to: Vec3): Quat {
  const d = dot(from, to);

  // Parallel — identity
  if (d > 0.999999) return IDENTITY;

  // Anti-parallel — 180 degree rotation around any perpendicular axis
  if (d < -0.999999) {
    // Find a perpendicular axis
    let perp: Vec3 = cross(from, { x: 1, y: 0, z: 0 });
    if (vecLength(perp) < 1e-6) {
      perp = cross(from, { x: 0, y: 1, z: 0 });
    }
    perp = normalizeVec(perp);
    return { x: perp.x, y: perp.y, z: perp.z, w: 0 };
  }

  const c = cross(from, to);
  const w = 1 + d;
  return normalize({ x: c.x, y: c.y, z: c.z, w });
}

/**
 * Euler angles (in radians) from quaternion.
 * Returns { x, y, z } in ZXY intrinsic order (BVH convention).
 * Output: Z rotation, X rotation, Y rotation.
 */
export function toEulerZXY(q: Quat): Vec3 {
  // ZXY intrinsic = YXZ extrinsic
  const sqx = q.x * q.x;
  const sqy = q.y * q.y;
  const sqz = q.z * q.z;
  const sqw = q.w * q.w;

  // X rotation (pitch)
  const sinX = 2 * (q.w * q.x - q.y * q.z);
  let rx: number;
  if (Math.abs(sinX) >= 1) {
    rx = Math.sign(sinX) * Math.PI / 2; // gimbal lock
  } else {
    rx = Math.asin(sinX);
  }

  // Y rotation (yaw)
  const ry = Math.atan2(
    2 * (q.w * q.y + q.x * q.z),
    sqw - sqx - sqy + sqz,
  );

  // Z rotation (roll)
  const rz = Math.atan2(
    2 * (q.w * q.z + q.x * q.y),
    sqw - sqx + sqy - sqz,
  );

  return { x: rx, y: ry, z: rz };
}

/**
 * Create quaternion from Euler angles (radians) in ZXY intrinsic order.
 */
export function fromEulerZXY(x: number, y: number, z: number): Quat {
  const cx = Math.cos(x * 0.5), sx = Math.sin(x * 0.5);
  const cy = Math.cos(y * 0.5), sy = Math.sin(y * 0.5);
  const cz = Math.cos(z * 0.5), sz = Math.sin(z * 0.5);

  // ZXY intrinsic: apply Z, then X, then Y
  return {
    x: cx * sy * sz + sx * cy * cz,
    y: cx * sy * cz - sx * cy * sz,
    z: cx * cy * sz - sx * sy * cz,
    w: cx * cy * cz + sx * sy * sz,
  };
}

/**
 * Rotate a vector by a quaternion: q * v * q^-1
 */
export function rotateVec(q: Quat, v: Vec3): Vec3 {
  const vq: Quat = { x: v.x, y: v.y, z: v.z, w: 0 };
  const result = multiply(multiply(q, vq), conjugate(q));
  return { x: result.x, y: result.y, z: result.z };
}

/**
 * Angle (in radians) between two quaternions.
 */
export function angleBetween(a: Quat, b: Quat): number {
  const d = Math.abs(dot_q(a, b));
  return 2 * Math.acos(Math.min(d, 1));
}

/**
 * Decompose a quaternion into swing and twist components around a given axis.
 *
 * q = swing * twist
 *
 * Twist rotates around the specified axis (e.g. the bone axis for forearm pronation).
 * Swing rotates perpendicular to that axis (e.g. elbow bend direction).
 *
 * Singularity handling: when q.w ≈ 0 AND projection ≈ 0 (180° swing
 * perpendicular to twist axis), defaults to identity twist.
 */
export function swingTwist(q: Quat, twistAxis: Vec3): { swing: Quat; twist: Quat } {
  // Project the quaternion's vector part onto the twist axis
  const projection = q.x * twistAxis.x + q.y * twistAxis.y + q.z * twistAxis.z;

  // Twist quaternion: rotation around the twist axis
  const rawTwist: Quat = {
    x: twistAxis.x * projection,
    y: twistAxis.y * projection,
    z: twistAxis.z * projection,
    w: q.w,
  };

  // Handle singularity: near-zero twist quaternion
  const twistLen = Math.sqrt(
    rawTwist.x * rawTwist.x + rawTwist.y * rawTwist.y +
    rawTwist.z * rawTwist.z + rawTwist.w * rawTwist.w,
  );
  if (twistLen < 1e-10) {
    return { swing: normalize(q), twist: IDENTITY };
  }

  const twist = normalize(rawTwist);
  const swing = normalize(multiply(q, inverse(twist)));

  return { swing, twist };
}
