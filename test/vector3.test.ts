import { describe, it, expect } from 'vitest';
import {
  vec3, add, sub, scale, dot, cross, length, normalize, lerp,
  distance, negate, midpoint, ZERO, UP, RIGHT, FORWARD,
} from '../src/math/vector3.js';

describe('vector3', () => {
  it('add', () => {
    const r = add(vec3(1, 2, 3), vec3(4, 5, 6));
    expect(r).toEqual({ x: 5, y: 7, z: 9 });
  });

  it('sub', () => {
    const r = sub(vec3(10, 20, 30), vec3(1, 2, 3));
    expect(r).toEqual({ x: 9, y: 18, z: 27 });
  });

  it('scale', () => {
    expect(scale(vec3(1, 2, 3), 2)).toEqual({ x: 2, y: 4, z: 6 });
  });

  it('dot product', () => {
    expect(dot(vec3(1, 0, 0), vec3(0, 1, 0))).toBe(0);
    expect(dot(vec3(1, 2, 3), vec3(4, 5, 6))).toBe(32);
  });

  it('cross product', () => {
    const r = cross(vec3(1, 0, 0), vec3(0, 1, 0));
    expect(r).toEqual({ x: 0, y: 0, z: 1 });
  });

  it('cross product anti-commutativity', () => {
    const a = vec3(1, 2, 3);
    const b = vec3(4, 5, 6);
    const ab = cross(a, b);
    const ba = cross(b, a);
    expect(ab.x).toBeCloseTo(-ba.x);
    expect(ab.y).toBeCloseTo(-ba.y);
    expect(ab.z).toBeCloseTo(-ba.z);
  });

  it('length', () => {
    expect(length(vec3(3, 4, 0))).toBeCloseTo(5);
    expect(length(ZERO)).toBe(0);
  });

  it('normalize', () => {
    const n = normalize(vec3(3, 0, 0));
    expect(n).toEqual({ x: 1, y: 0, z: 0 });
    expect(length(normalize(vec3(1, 2, 3)))).toBeCloseTo(1);
  });

  it('normalize zero vector returns zero', () => {
    expect(normalize(ZERO)).toEqual(ZERO);
  });

  it('lerp', () => {
    const a = vec3(0, 0, 0);
    const b = vec3(10, 20, 30);
    expect(lerp(a, b, 0)).toEqual(a);
    expect(lerp(a, b, 1)).toEqual(b);
    expect(lerp(a, b, 0.5)).toEqual({ x: 5, y: 10, z: 15 });
  });

  it('distance', () => {
    expect(distance(vec3(0, 0, 0), vec3(3, 4, 0))).toBeCloseTo(5);
  });

  it('negate', () => {
    expect(negate(vec3(1, -2, 3))).toEqual({ x: -1, y: 2, z: -3 });
  });

  it('midpoint', () => {
    expect(midpoint(vec3(0, 0, 0), vec3(10, 10, 10))).toEqual({ x: 5, y: 5, z: 5 });
  });

  it('constants', () => {
    expect(UP).toEqual({ x: 0, y: 1, z: 0 });
    expect(RIGHT).toEqual({ x: 1, y: 0, z: 0 });
    expect(FORWARD).toEqual({ x: 0, y: 0, z: 1 });
  });
});
