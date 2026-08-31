import type { Landmark, FramePose, HandPose } from './types.js';

/**
 * Z-axis damping factor. Monocular depth (Z) from BlazePose is ~200x noisier
 * than XY. We apply heavier smoothing on Z by scaling alpha down.
 */
const Z_DAMPING = 0.3;

/**
 * Temporal smoother using Exponential Moving Average (EMA).
 * Ported from frankmocap_fork's __smooth_hand_bboxes approach,
 * extended to per-landmark 3D smoothing with confidence weighting.
 *
 * Formula: smoothed = effectiveAlpha * current + (1 - effectiveAlpha) * previous
 * Where:   effectiveAlpha = baseAlpha * visibility
 *
 * Z-axis gets additional damping (Z_DAMPING=0.3) because monocular depth
 * estimates are ~200x noisier than XY from a single camera view.
 *
 * High visibility → favor current frame (less smoothing).
 * Low visibility  → favor previous frame (more smoothing, reduces jitter from bad detections).
 */
export class TemporalSmoother {
  private readonly alpha: number;
  private prevBody: Landmark[] | null = null;
  private prevLeftHand: Landmark[] | null = null;
  private prevRightHand: Landmark[] | null = null;

  constructor(alpha: number = 0.7) {
    if (alpha < 0 || alpha > 1) throw new Error('Alpha must be between 0 and 1');
    this.alpha = alpha;
  }

  smooth(frame: FramePose): FramePose {
    const body = this.smoothLandmarks(frame.body, this.prevBody);
    this.prevBody = body;

    let leftHand = frame.leftHand;
    if (leftHand) {
      const smoothed = this.smoothLandmarks(leftHand.landmarks, this.prevLeftHand);
      this.prevLeftHand = smoothed;
      leftHand = { landmarks: smoothed };
    } else if (this.prevLeftHand) {
      // Detection lost — decay previous toward rest (reduce visibility)
      this.prevLeftHand = this.prevLeftHand.map(lm => ({
        ...lm,
        visibility: lm.visibility * 0.9,
      }));
    }

    let rightHand = frame.rightHand;
    if (rightHand) {
      const smoothed = this.smoothLandmarks(rightHand.landmarks, this.prevRightHand);
      this.prevRightHand = smoothed;
      rightHand = { landmarks: smoothed };
    } else if (this.prevRightHand) {
      this.prevRightHand = this.prevRightHand.map(lm => ({
        ...lm,
        visibility: lm.visibility * 0.9,
      }));
    }

    return { body, leftHand, rightHand, frameIndex: frame.frameIndex };
  }

  reset(): void {
    this.prevBody = null;
    this.prevLeftHand = null;
    this.prevRightHand = null;
  }

  private smoothLandmarks(current: Landmark[], previous: Landmark[] | null): Landmark[] {
    // First frame — no smoothing
    if (!previous) return current.map(lm => ({ ...lm }));

    return current.map((lm, i) => {
      const prev = previous[i];
      if (!prev) return { ...lm };

      // Confidence-weighted alpha: low visibility = heavier smoothing
      const effectiveAlpha = this.alpha * Math.max(lm.visibility, 0.1);
      const zAlpha = effectiveAlpha * Z_DAMPING;

      return {
        x: effectiveAlpha * lm.x + (1 - effectiveAlpha) * prev.x,
        y: effectiveAlpha * lm.y + (1 - effectiveAlpha) * prev.y,
        z: zAlpha * lm.z + (1 - zAlpha) * prev.z,
        visibility: Math.max(lm.visibility, prev.visibility * 0.9),
      };
    });
  }
}
