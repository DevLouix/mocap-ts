import type { Vec3 } from './vector3.js';
import type { Quat } from './quaternion.js';

/** 3x3 rotation matrix stored as row-major flat array [m00, m01, m02, m10, ...] */
export type Mat3 = [
  number, number, number,
  number, number, number,
  number, number, number,
];

export function mat3FromQuat(q: Quat): Mat3 {
  const xx = q.x * q.x, xy = q.x * q.y, xz = q.x * q.z, xw = q.x * q.w;
  const yy = q.y * q.y, yz = q.y * q.z, yw = q.y * q.w;
  const zz = q.z * q.z, zw = q.z * q.w;

  return [
    1 - 2 * (yy + zz), 2 * (xy - zw),     2 * (xz + yw),
    2 * (xy + zw),     1 - 2 * (xx + zz),  2 * (yz - xw),
    2 * (xz - yw),     2 * (yz + xw),      1 - 2 * (xx + yy),
  ];
}

export function mat3MulVec(m: Mat3, v: Vec3): Vec3 {
  return {
    x: m[0] * v.x + m[1] * v.y + m[2] * v.z,
    y: m[3] * v.x + m[4] * v.y + m[5] * v.z,
    z: m[6] * v.x + m[7] * v.y + m[8] * v.z,
  };
}

export function mat3Transpose(m: Mat3): Mat3 {
  return [
    m[0], m[3], m[6],
    m[1], m[4], m[7],
    m[2], m[5], m[8],
  ];
}

export function mat3Mul(a: Mat3, b: Mat3): Mat3 {
  return [
    a[0]*b[0] + a[1]*b[3] + a[2]*b[6], a[0]*b[1] + a[1]*b[4] + a[2]*b[7], a[0]*b[2] + a[1]*b[5] + a[2]*b[8],
    a[3]*b[0] + a[4]*b[3] + a[5]*b[6], a[3]*b[1] + a[4]*b[4] + a[5]*b[7], a[3]*b[2] + a[4]*b[5] + a[5]*b[8],
    a[6]*b[0] + a[7]*b[3] + a[8]*b[6], a[6]*b[1] + a[7]*b[4] + a[8]*b[7], a[6]*b[2] + a[7]*b[5] + a[8]*b[8],
  ];
}

export const MAT3_IDENTITY: Mat3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];
