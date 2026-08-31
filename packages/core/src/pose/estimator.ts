import { readFileSync } from 'node:fs';
import type { Landmark, FramePose } from './types.js';

// Register TF.js Node backend (C++ ops, no WebGL/WASM needed)
import * as tf from '@tensorflow/tfjs-node';
import * as poseDetection from '@tensorflow-models/pose-detection';

/**
 * MoveNet COCO 17 keypoints → BlazePose 33-slot index mapping.
 *
 * MoveNet gives 17 keypoints in COCO format. Our skeleton mapping
 * expects BlazePose's 33-point layout. This table maps every MoveNet
 * index to the corresponding BlazePose index. Unmapped BlazePose slots
 * get { x:0.5, y:0.5, z:0, visibility:0 } (invisible, centered).
 */
const COCO_TO_BLAZEPOSE: Record<number, number> = {
  0: 0,   // nose
  1: 2,   // left_eye
  2: 5,   // right_eye
  3: 7,   // left_ear
  4: 8,   // right_ear
  5: 11,  // left_shoulder
  6: 12,  // right_shoulder
  7: 13,  // left_elbow
  8: 14,  // right_elbow
  9: 15,  // left_wrist
  10: 16, // right_wrist
  11: 23, // left_hip
  12: 24, // right_hip
  13: 25, // left_knee
  14: 26, // right_knee
  15: 27, // left_ankle
  16: 28, // right_ankle
};

export interface EstimatorOptions {
  hands?: boolean;
  verbose?: boolean;
  /** Enable multi-person tracking (MoveNet MultiPose). Default false. */
  multipose?: boolean;
  /** Max people to detect per frame when multipose is on. Default 6. */
  maxPoses?: number;
  /** Backend: 'cpu' (tfjs-node default) or 'webgpu' (browser). Default 'cpu'. */
  backend?: 'cpu' | 'webgpu';
}

export interface Estimator {
  estimateFrame(imagePath: string, frameIndex: number): Promise<FramePose>;
  estimateFrameFromBuffer(buffer: Uint8Array, width: number, height: number, frameIndex: number): Promise<FramePose>;
  /** Multi-person variant: returns one FramePose per detected person. */
  estimateFrameMulti?(imagePath: string, frameIndex: number): Promise<FramePose[]>;
  close(): void;
}

/**
 * Create a pose estimator using MoveNet (SinglePose.Thunder).
 *
 * MoveNet works reliably with @tensorflow/tfjs-node — no Transform kernel
 * issues like BlazePose. Returns 17 COCO keypoints which are mapped to
 * the 33-point BlazePose format expected by the rest of the pipeline.
 *
 * Note: Hand detection is not available with MoveNet. The swing-twist
 * decomposition in ik.ts gracefully decays forearm twist toward identity
 * when hand landmarks are absent.
 */
export async function createEstimator(options: EstimatorOptions = {}): Promise<Estimator> {
  if (options.verbose) console.error('[mocap-ts] Initializing MoveNet pose estimator...');
  if (options.hands) {
    console.error('[mocap-ts] Warning: Hand detection not available with MoveNet (ignored)');
  }

  // WebGPU backend option (experimental). In tfjs-node we default to CPU,
  // which uses the libtensorflow C++ kernels. WebGPU is for browser runs.
  if (options.backend === 'webgpu') {
    try {
      // Optional backend: not a hard dep, so the module is only resolved
      // at runtime when the user installs @tensorflow/tfjs-webgpu.
      await import('@tensorflow/tfjs-webgpu').catch(() => {});
      await tf.setBackend('webgpu');
      await tf.ready();
      if (options.verbose) console.error('[mocap-ts] WebGPU backend ready');
    } catch {
      console.error('[mocap-ts] WebGPU backend unavailable, falling back to CPU');
    }
  }

  const modelType = options.multipose
    ? poseDetection.movenet.modelType.MULTIPOSE_LIGHTNING
    : poseDetection.movenet.modelType.SINGLEPOSE_THUNDER;

  const poseDetector = await poseDetection.createDetector(
    poseDetection.SupportedModels.MoveNet,
    {
      modelType,
      ...(options.multipose ? { multiPoseMaxDimension: 257, enableTracking: true, maxPoses: options.maxPoses ?? 6 } : {}),
    },
  );

  if (options.verbose) console.error(`[mocap-ts] Estimator ready (${options.multipose ? 'multipose' : 'singlepose'})`);

  function cocoToBlazePose(
    keypoints: poseDetection.Keypoint[],
    width: number,
    height: number,
  ): Landmark[] {
    // Start with 33 invisible landmarks at image center
    const body: Landmark[] = new Array(33).fill(null).map(() => ({
      x: 0.5, y: 0.5, z: 0, visibility: 0,
    }));

    for (let i = 0; i < keypoints.length; i++) {
      const bpIdx = COCO_TO_BLAZEPOSE[i];
      if (bpIdx === undefined) continue;
      const kp = keypoints[i];
      body[bpIdx] = {
        x: kp.x / width,
        y: kp.y / height,
        z: 0,  // MoveNet is 2D — no depth
        visibility: kp.score ?? 0,
      };
    }

    return body;
  }

  async function estimateFrame(imagePath: string, frameIndex: number): Promise<FramePose> {
    const imageBuffer = readFileSync(imagePath);
    const tensor = tf.node.decodeImage(imageBuffer, 3) as tf.Tensor3D;

    try {
      return await estimateFromTensor(tensor, frameIndex);
    } finally {
      tensor.dispose();
    }
  }

  async function estimateFrameFromBuffer(
    buffer: Uint8Array, width: number, height: number, frameIndex: number,
  ): Promise<FramePose> {
    const tensor = tf.tensor3d(
      new Uint8Array(buffer.buffer, buffer.byteOffset, width * height * 4),
      [height, width, 4],
    );
    const rgb = tensor.slice([0, 0, 0], [-1, -1, 3]) as tf.Tensor3D;
    tensor.dispose();

    try {
      return await estimateFromTensor(rgb, frameIndex);
    } finally {
      rgb.dispose();
    }
  }

  async function estimateFromTensor(tensor: tf.Tensor3D, frameIndex: number): Promise<FramePose> {
    const poses = await poseDetector.estimatePoses(tensor);
    let body: Landmark[] = new Array(33).fill(null).map(() => ({
      x: 0.5, y: 0.5, z: 0, visibility: 0,
    }));

    if (poses.length > 0 && poses[0].keypoints) {
      body = cocoToBlazePose(poses[0].keypoints, tensor.shape[1], tensor.shape[0]);
    }

    return { body, frameIndex };
  }

  /** Multi-person: one FramePose per detected person, with a person id tag. */
  async function estimateFrameMulti(imagePath: string, frameIndex: number): Promise<FramePose[]> {
    const imageBuffer = readFileSync(imagePath);
    const tensor = tf.node.decodeImage(imageBuffer, 3) as tf.Tensor3D;
    try {
      const poses = await poseDetector.estimatePoses(tensor);
      return poses.map((p, idx) => ({
        body: p.keypoints ? cocoToBlazePose(p.keypoints, tensor.shape[1], tensor.shape[0]) : [],
        frameIndex,
        // Stash the MoveNet-assigned person id so callers can correlate
        // across frames. MoveNet MultiPose assigns `id`; fall back to idx.
        ...({ personId: (p as { id?: number }).id ?? idx }),
      })) as unknown as FramePose[];
    } finally {
      tensor.dispose();
    }
  }

  function close(): void {
    poseDetector.dispose();
  }

  return { estimateFrame, estimateFrameFromBuffer, estimateFrameMulti, close };
}
