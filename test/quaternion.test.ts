import { describe, it, expect } from 'vitest';
import {
  IDENTITY, multiply, conjugate, inverse, normalize, length, slerp,
  fromAxisAngle, fromUnitVectors, toEulerZXY, fromEulerZXY, rotateVec,
  angleBetween, dot_q, swingTwist,
} from '../src/math/quaternion.js';
import type { Quat } from '../src/math/quaternion.js';

const EPSILON = 1e-6;

function expectQuatClose(a: Quat, b: Quat, eps = EPSILON) {
  // Quaternions q and -q represent the same rotation
  const sign = dot_q(a, b) >= 0 ? 1 : -1;
  expect(a.x).toBeCloseTo(b.x * sign, 5);
  expect(a.y).toBeCloseTo(b.y * sign, 5);
  expect(a.z).toBeCloseTo(b.z * sign, 5);
  expect(a.w).toBeCloseTo(b.w * sign, 5);
}

describe('quaternion', () => {
  it('identity has unit length', () => {
    expect(length(IDENTITY)).toBeCloseTo(1);
  });

  it('multiply by identity returns same quaternion', () => {
    const q = fromAxisAngle({ x: 0, y: 1, z: 0 }, Math.PI / 4);
    expectQuatClose(multiply(q, IDENTITY), q);
    expectQuatClose(multiply(IDENTITY, q), q);
  });

  it('multiply by inverse returns identity', () => {
    const q = fromAxisAngle({ x: 1, y: 0, z: 0 }, Math.PI / 3);
    const result = multiply(q, inverse(q));
    expectQuatClose(result, IDENTITY);
  });

  it('conjugate of unit quaternion equals inverse', () => {
    const q = normalize(fromAxisAngle({ x: 0, y: 0, z: 1 }, 1.2));
    const conj = conjugate(q);
    const inv = inverse(q);
    expectQuatClose(conj, inv);
  });

  it('normalize produces unit length', () => {
    const q = { x: 1, y: 2, z: 3, w: 4 };
    expect(length(normalize(q))).toBeCloseTo(1);
  });

  it('slerp at t=0 returns a, t=1 returns b', () => {
    const a = fromAxisAngle({ x: 0, y: 1, z: 0 }, 0);
    const b = fromAxisAngle({ x: 0, y: 1, z: 0 }, Math.PI / 2);
    expectQuatClose(slerp(a, b, 0), a);
    expectQuatClose(slerp(a, b, 1), b);
  });

  it('slerp at t=0.5 gives halfway rotation', () => {
    const a = IDENTITY;
    const b = fromAxisAngle({ x: 0, y: 1, z: 0 }, Math.PI / 2);
    const mid = slerp(a, b, 0.5);
    const expected = fromAxisAngle({ x: 0, y: 1, z: 0 }, Math.PI / 4);
    expectQuatClose(mid, expected);
  });

  it('fromAxisAngle with zero angle returns identity', () => {
    const q = fromAxisAngle({ x: 1, y: 0, z: 0 }, 0);
    expectQuatClose(q, IDENTITY);
  });

  it('fromAxisAngle with 180 degrees produces correct rotation', () => {
    const q = fromAxisAngle({ x: 0, y: 1, z: 0 }, Math.PI);
    // Rotate +X around Y by 180 degrees → should give -X
    const result = rotateVec(q, { x: 1, y: 0, z: 0 });
    expect(result.x).toBeCloseTo(-1, 5);
    expect(result.y).toBeCloseTo(0, 5);
    expect(result.z).toBeCloseTo(0, 4); // numerical precision
  });

  it('fromUnitVectors — parallel vectors return identity', () => {
    const q = fromUnitVectors({ x: 0, y: 1, z: 0 }, { x: 0, y: 1, z: 0 });
    expectQuatClose(q, IDENTITY);
  });

  it('fromUnitVectors — X to Y gives 90 degree Z rotation', () => {
    const q = fromUnitVectors({ x: 1, y: 0, z: 0 }, { x: 0, y: 1, z: 0 });
    const result = rotateVec(q, { x: 1, y: 0, z: 0 });
    expect(result.x).toBeCloseTo(0, 5);
    expect(result.y).toBeCloseTo(1, 5);
    expect(result.z).toBeCloseTo(0, 5);
  });

  it('fromUnitVectors — anti-parallel vectors give 180 degree rotation', () => {
    const q = fromUnitVectors({ x: 1, y: 0, z: 0 }, { x: -1, y: 0, z: 0 });
    const result = rotateVec(q, { x: 1, y: 0, z: 0 });
    expect(result.x).toBeCloseTo(-1, 5);
    expect(result.y).toBeCloseTo(0, 4);
    expect(result.z).toBeCloseTo(0, 4);
  });

  it('toEulerZXY → fromEulerZXY roundtrip', () => {
    const angles = [
      { x: 0.3, y: 0.5, z: 0.1 },
      { x: -0.8, y: 1.2, z: -0.4 },
      { x: 0, y: 0, z: 0 },
      { x: Math.PI / 4, y: -Math.PI / 3, z: Math.PI / 6 },
    ];

    for (const euler of angles) {
      const q = fromEulerZXY(euler.x, euler.y, euler.z);
      const back = toEulerZXY(q);
      const q2 = fromEulerZXY(back.x, back.y, back.z);
      expectQuatClose(q, q2);
    }
  });

  it('rotateVec preserves vector length', () => {
    const q = fromAxisAngle({ x: 1, y: 1, z: 1 }, 1.5);
    const v = { x: 3, y: 4, z: 5 };
    const r = rotateVec(q, v);
    const origLen = Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z);
    const newLen = Math.sqrt(r.x * r.x + r.y * r.y + r.z * r.z);
    expect(newLen).toBeCloseTo(origLen, 5);
  });

  it('angleBetween identity and itself is 0', () => {
    expect(angleBetween(IDENTITY, IDENTITY)).toBeCloseTo(0);
  });

  it('angleBetween detects 90 degree rotation', () => {
    const q = fromAxisAngle({ x: 0, y: 1, z: 0 }, Math.PI / 2);
    expect(angleBetween(IDENTITY, q)).toBeCloseTo(Math.PI / 2, 4);
  });
});

describe('swingTwist', () => {
  it('pure twist around axis decomposes correctly', () => {
    // Rotate 45° around X axis — this is pure twist when twist axis is X
    const q = fromAxisAngle({ x: 1, y: 0, z: 0 }, Math.PI / 4);
    const { swing, twist } = swingTwist(q, { x: 1, y: 0, z: 0 });

    // Twist should equal the original rotation
    expectQuatClose(twist, q);
    // Swing should be identity
    expectQuatClose(swing, IDENTITY);
  });

  it('pure swing perpendicular to axis decomposes correctly', () => {
    // Rotate 45° around Y axis — pure swing when twist axis is X
    const q = fromAxisAngle({ x: 0, y: 1, z: 0 }, Math.PI / 4);
    const { swing, twist } = swingTwist(q, { x: 1, y: 0, z: 0 });

    // Twist should be near identity (no rotation around X)
    expect(angleBetween(twist, IDENTITY)).toBeLessThan(0.01);
    // Swing should match original
    expectQuatClose(swing, q);
  });

  it('recomposes to original: swing * twist = q', () => {
    // Arbitrary rotation
    const q = normalize(fromAxisAngle({ x: 0.5, y: 0.3, z: 0.8 }, 1.2));
    const { swing, twist } = swingTwist(q, { x: 1, y: 0, z: 0 });

    const recomposed = multiply(swing, twist);
    expectQuatClose(recomposed, q);
  });

  it('extracts known forearm twist angle', () => {
    // Combine a swing (elbow bend around Z) with a twist (forearm roll around X)
    const swingQ = fromAxisAngle({ x: 0, y: 0, z: 1 }, Math.PI / 3); // 60° elbow bend
    const twistQ = fromAxisAngle({ x: 1, y: 0, z: 0 }, Math.PI / 6); // 30° forearm roll
    const combined = multiply(swingQ, twistQ);

    const { twist } = swingTwist(combined, { x: 1, y: 0, z: 0 });

    // Extracted twist angle should be close to 30° (within 10°)
    const twistAngle = angleBetween(twist, IDENTITY) * (180 / Math.PI);
    expect(twistAngle).toBeCloseTo(30, -1); // within 5° tolerance
  });

  it('handles identity quaternion', () => {
    const { swing, twist } = swingTwist(IDENTITY, { x: 0, y: 1, z: 0 });
    expectQuatClose(swing, IDENTITY);
    expectQuatClose(twist, IDENTITY);
  });
});
