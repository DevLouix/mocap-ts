import { writeFileSync, statSync, existsSync } from 'node:fs';
import type { CliOptions } from './cli.js';
import { extractFrames, loadFrameDir, isVideoUrl, downloadVideo } from './video/decoder.js';
import { validateRemoteVideoUrl } from './video/url-policy.js';
import { createEstimator } from './pose/estimator.js';
import { TemporalSmoother } from './pose/smoother.js';
import { createSkeleton } from './skeleton/hierarchy.js';
import { calibrateSkeleton } from './skeleton/calibrate.js';
import { solveIK } from './skeleton/ik.js';
import { writeBVH } from './export/bvh.js';
import type { FramePose } from './pose/types.js';
import type { IKFrame } from './skeleton/ik.js';
import type { Quat } from './math/quaternion.js';

function log(msg: string, verbose?: boolean): void {
  if (verbose !== false) console.error(`[mocap-ts] ${msg}`);
}

/**
 * Run the full mocap pipeline: video/URL → frames → pose → smooth → IK → BVH.
 */
export async function runPipeline(opts: CliOptions): Promise<void> {
  const startTime = Date.now();

  let framePaths: string[];
  let sourceFps: number | undefined;
  let videoInput = opts.input;

  // Step 0: If input is a URL, download it first
  if (isVideoUrl(opts.input)) {
    await validateRemoteVideoUrl(opts.input);
    log('Downloading video...', true);
    const { videoPath, title } = downloadVideo(opts.input, { verbose: opts.verbose });
    videoInput = videoPath;

    // Default output name from video title if user didn't specify one
    if (!opts.output || opts.output === opts.input.replace(/\.[^.]+$/, '.bvh')) {
      opts.output = `${title}.bvh`;
    }
    log(`Downloaded: ${videoInput}`, opts.verbose);
  }

  // Step 1: Resolve input to frame paths
  if (!existsSync(videoInput)) {
    throw new Error(`Input not found: ${videoInput}`);
  }

  const stat = statSync(videoInput);

  if (stat.isDirectory()) {
    log('Loading frames from directory...', opts.verbose);
    framePaths = loadFrameDir(videoInput);
    if (framePaths.length === 0) {
      throw new Error(`No image files found in: ${videoInput}`);
    }
    log(`Found ${framePaths.length} frames`, opts.verbose);
  } else {
    log(`Extracting frames from video (fps: ${opts.fps ?? 'source'})...`, opts.verbose);
    const result = extractFrames(videoInput, { fps: opts.fps, verbose: opts.verbose });
    framePaths = result.frames;
    sourceFps = result.sourceFps;
    if (framePaths.length === 0) {
      throw new Error('No frames extracted from video. Is ffmpeg installed?');
    }
    log(`Extracted ${framePaths.length} frames (source fps: ${sourceFps ?? 'unknown'})`, opts.verbose);
  }

  const fps = opts.fps ?? sourceFps ?? 30;

  // Stage 1: Pose estimation
  log('Initializing pose estimator...', opts.verbose);
  const estimator = await createEstimator({
    hands: opts.hands,
    verbose: opts.verbose,
  });

  log('Estimating poses...', opts.verbose);
  const poses: FramePose[] = [];
  for (let i = 0; i < framePaths.length; i++) {
    if (opts.verbose && i % 10 === 0) {
      log(`  Frame ${i + 1}/${framePaths.length}`, true);
    }
    const pose = await estimator.estimateFrame(framePaths[i], i);
    poses.push(pose);
  }
  estimator.close();

  if (poses.length === 0) {
    throw new Error('No poses detected in any frame');
  }

  log(`Estimated ${poses.length} poses`, opts.verbose);

  // Stage 2: Temporal smoothing
  log(`Smoothing (alpha=${opts.smoothing})...`, opts.verbose);
  const smoother = new TemporalSmoother(opts.smoothing);
  const smoothedPoses = poses.map(p => smoother.smooth(p));

  // Stage 3: Calibrate skeleton to person's proportions
  log('Calibrating skeleton...', opts.verbose);
  const skeleton = calibrateSkeleton(smoothedPoses, opts.verbose);

  // Stage 4: IK solve
  log('Solving inverse kinematics...', opts.verbose);
  const ikFrames: IKFrame[] = [];
  let prevRotations: Quat[] | undefined;

  for (const pose of smoothedPoses) {
    const frame = solveIK(pose, skeleton, prevRotations);
    ikFrames.push(frame);
    prevRotations = frame.localRotations;
  }

  // Stage 5: BVH export
  log('Writing BVH...', opts.verbose);
  const bvh = writeBVH(skeleton, ikFrames, fps);
  writeFileSync(opts.output, bvh, 'utf-8');

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  const perFrame = ((Date.now() - startTime) / framePaths.length).toFixed(0);

  log(`Done! ${framePaths.length} frames → ${opts.output}`, true);
  log(`  Time: ${elapsed}s (${perFrame}ms/frame)`, true);
  log(`  FPS: ${fps}, Hands: ${opts.hands}, Smoothing: ${opts.smoothing}`, opts.verbose);
}
