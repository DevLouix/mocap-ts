import { describe, it, expect } from 'vitest';
import { TemporalSmoother } from '../src/pose/smoother.js';
import type { Landmark, FramePose } from '../src/pose/types.js';

function makeLandmark(x: number, y: number, z: number, vis: number = 1): Landmark {
  return { x, y, z, visibility: vis };
}

function makeFrame(index: number, xOffset: number = 0): FramePose {
  return {
    body: [
      makeLandmark(0.5 + xOffset, 0.5, 0),
      makeLandmark(0.3 + xOffset, 0.3, 0),
    ],
    frameIndex: index,
  };
}

describe('TemporalSmoother', () => {
  it('first frame passes through unchanged', () => {
    const smoother = new TemporalSmoother(0.7);
    const frame = makeFrame(0);
    const result = smoother.smooth(frame);

    expect(result.body[0].x).toBeCloseTo(0.5);
    expect(result.body[0].y).toBeCloseTo(0.5);
  });

  it('second frame is blended with first', () => {
    const smoother = new TemporalSmoother(0.7);

    const f0 = makeFrame(0, 0);
    const f1 = makeFrame(1, 0.1); // shifted right by 0.1

    smoother.smooth(f0);
    const result = smoother.smooth(f1);

    // With alpha=0.7 and visibility=1, effectiveAlpha = 0.7
    // smoothed.x = 0.7 * 0.6 + 0.3 * 0.5 = 0.42 + 0.15 = 0.57
    expect(result.body[0].x).toBeCloseTo(0.57, 2);
  });

  it('reduces jitter in noisy sequence', () => {
    const smoother = new TemporalSmoother(0.7);

    // Jittery sequence oscillating around 0.5
    const positions = [0.5, 0.55, 0.45, 0.6, 0.4, 0.55, 0.45];
    const results: number[] = [];

    for (let i = 0; i < positions.length; i++) {
      const frame: FramePose = {
        body: [makeLandmark(positions[i], 0.5, 0)],
        frameIndex: i,
      };
      const smoothed = smoother.smooth(frame);
      results.push(smoothed.body[0].x);
    }

    // Compute variance of input and output
    const mean = (arr: number[]) => arr.reduce((s, v) => s + v, 0) / arr.length;
    const variance = (arr: number[]) => {
      const m = mean(arr);
      return arr.reduce((s, v) => s + (v - m) ** 2, 0) / arr.length;
    };

    expect(variance(results)).toBeLessThan(variance(positions));
  });

  it('low visibility causes heavier smoothing', () => {
    const smoother = new TemporalSmoother(0.7);

    const f0: FramePose = {
      body: [makeLandmark(0.5, 0.5, 0, 1.0)],
      frameIndex: 0,
    };
    smoother.smooth(f0);

    // Frame with low visibility — should heavily weight previous
    const f1: FramePose = {
      body: [makeLandmark(0.8, 0.5, 0, 0.1)],
      frameIndex: 1,
    };
    const result = smoother.smooth(f1);

    // effectiveAlpha = 0.7 * max(0.1, 0.1) = 0.07
    // x = 0.07 * 0.8 + 0.93 * 0.5 = 0.056 + 0.465 = 0.521
    expect(result.body[0].x).toBeCloseTo(0.521, 2);
  });

  it('reset clears state', () => {
    const smoother = new TemporalSmoother(0.7);
    smoother.smooth(makeFrame(0, 0));
    smoother.reset();

    // After reset, first frame should pass through unchanged
    const f = makeFrame(1, 0.2);
    const result = smoother.smooth(f);
    expect(result.body[0].x).toBeCloseTo(0.7); // 0.5 + 0.2
  });

  it('throws on invalid alpha', () => {
    expect(() => new TemporalSmoother(-0.1)).toThrow();
    expect(() => new TemporalSmoother(1.5)).toThrow();
  });

  it('Z-axis gets heavier smoothing than XY', () => {
    const smoother = new TemporalSmoother(0.7);

    // Same jump on X and Z — Z should be smoothed more
    const f0: FramePose = {
      body: [makeLandmark(0.5, 0.5, 0.5, 1.0)],
      frameIndex: 0,
    };
    smoother.smooth(f0);

    const f1: FramePose = {
      body: [makeLandmark(0.8, 0.5, 0.8, 1.0)],
      frameIndex: 1,
    };
    const result = smoother.smooth(f1);

    // X: effectiveAlpha = 0.7, smoothed = 0.7 * 0.8 + 0.3 * 0.5 = 0.71
    // Z: zAlpha = 0.7 * 0.3 = 0.21, smoothed = 0.21 * 0.8 + 0.79 * 0.5 = 0.563
    const xDelta = Math.abs(result.body[0].x - 0.5);
    const zDelta = Math.abs(result.body[0].z - 0.5);
    // Z should move less from the previous value (more damped)
    expect(zDelta).toBeLessThan(xDelta);
  });

  it('Z-axis noise is reduced more than XY noise', () => {
    const smoother = new TemporalSmoother(0.7);

    // Sequence with equal noise on X and Z
    const noise = [0, 0.05, -0.05, 0.1, -0.1, 0.05, -0.05, 0.08, -0.08, 0.03];
    const xResults: number[] = [];
    const zResults: number[] = [];

    for (let i = 0; i < noise.length; i++) {
      const frame: FramePose = {
        body: [makeLandmark(0.5 + noise[i], 0.5, 0.5 + noise[i], 1.0)],
        frameIndex: i,
      };
      const smoothed = smoother.smooth(frame);
      xResults.push(smoothed.body[0].x);
      zResults.push(smoothed.body[0].z);
    }

    const variance = (arr: number[]) => {
      const m = arr.reduce((s, v) => s + v, 0) / arr.length;
      return arr.reduce((s, v) => s + (v - m) ** 2, 0) / arr.length;
    };

    // Z variance should be < 30% of X variance (Z_DAMPING = 0.3)
    expect(variance(zResults)).toBeLessThan(variance(xResults) * 0.5);
  });

  it('handles hand smoothing', () => {
    const smoother = new TemporalSmoother(0.7);

    const f0: FramePose = {
      body: [makeLandmark(0.5, 0.5, 0)],
      leftHand: { landmarks: [makeLandmark(0.3, 0.3, 0)] },
      frameIndex: 0,
    };
    const f1: FramePose = {
      body: [makeLandmark(0.5, 0.5, 0)],
      leftHand: { landmarks: [makeLandmark(0.4, 0.3, 0)] },
      frameIndex: 1,
    };

    smoother.smooth(f0);
    const result = smoother.smooth(f1);

    expect(result.leftHand).toBeDefined();
    // Should be blended, not raw
    expect(result.leftHand!.landmarks[0].x).not.toBe(0.4);
    expect(result.leftHand!.landmarks[0].x).toBeGreaterThan(0.3);
    expect(result.leftHand!.landmarks[0].x).toBeLessThan(0.4);
  });
});
