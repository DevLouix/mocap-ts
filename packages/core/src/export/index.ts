/**
 * Motion export module.
 *
 * {@link writeMotion} dispatches by format so the pipeline/UI can offer a
 * single entry point. Adding a format = add a writer + a case here.
 */
import type { SkeletonDef } from '../skeleton/hierarchy.js';
import type { IKFrame } from '../skeleton/ik.js';
import { writeBVH } from './bvh.js';
import { writeFBX } from './fbx.js';

export type MotionFormat = 'bvh' | 'fbx';

export interface ExportOptions {
  format: MotionFormat;
  /** Clip name (used by FBX Take name + output filename). */
  name?: string;
}

/**
 * Serialize a skeleton + animation to the requested motion format string.
 *
 * @param skeleton  calibrated skeleton
 * @param frames    per-frame IK results
 * @param fps       frames per second
 * @param options   format + optional name
 */
export function writeMotion(
  skeleton: SkeletonDef,
  frames: IKFrame[],
  fps: number,
  options: ExportOptions,
): string {
  switch (options.format) {
    case 'bvh': return writeBVH(skeleton, frames, fps);
    case 'fbx': return writeFBX(skeleton, frames, fps, options.name ?? 'mocap');
    default: {
      const _exhaustive: never = options.format;
      throw new Error(`Unsupported motion format: ${String(_exhaustive)}`);
    }
  }
}

export { writeBVH } from './bvh.js';
export { writeFBX } from './fbx.js';
