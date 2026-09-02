import { existsSync, mkdirSync, writeFileSync, statSync, rmSync } from 'node:fs';
import { join, basename, extname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import type { CliOptions } from '../cli.js';
import { extractFrames, loadFrameDir, downloadVideo } from '../video/decoder.js';
import { validateRemoteVideoUrl } from '../video/url-policy.js';
import { createEstimator } from '../pose/estimator.js';
import { TemporalSmoother } from '../pose/smoother.js';
import { calibrateSkeleton } from '../skeleton/calibrate.js';
import { solveIK } from '../skeleton/ik.js';
import { writeBVH } from '../export/bvh.js';
import { writeMotion, type MotionFormat } from '../export/index.js';
import type { FramePose } from '../pose/types.js';
import type { IKFrame } from '../skeleton/ik.js';
import type { Quat } from '../math/quaternion.js';
import { JobStage } from './types.js';
import type { Job, JobSettings } from './types.js';
import { createFootLockState } from '../skeleton/ik.js';
import type { JobQueue } from './queue.js';
import { stageMessage } from './types.js';

/**
 * Progress callback passed into the streaming pipeline runner.
 *
 * `stageProgress` is 0..1 *within the current stage*. The runner maps that
 * onto a fixed per-stage weight so the caller sees a monotonically increasing
 * overall progress. Weights sum to 1.
 */
export type ProgressFn = (stage: JobStage, stageProgress: number, detail?: string) => void;

const STAGE_WEIGHTS: Record<Exclude<JobStage, 'queued' | 'done' | 'failed' | 'cancelled'>, number> = {
  downloading: 0.05,
  extracting: 0.10,
  estimating: 0.65,
  smoothing: 0.05,
  calibrating: 0.05,
  solving_ik: 0.07,
  writing_bvh: 0.03,
};

const STAGE_ORDER: (keyof typeof STAGE_WEIGHTS)[] = [
  'downloading',
  'extracting',
  'estimating',
  'smoothing',
  'calibrating',
  'solving_ik',
  'writing_bvh',
];

/** Cumulative progress at the start of each stage. */
const STAGE_BASE: Map<JobStage, number> = (() => {
  const m = new Map<JobStage, number>();
  let acc = 0;
  for (const s of STAGE_ORDER) {
    m.set(s, acc);
    acc += STAGE_WEIGHTS[s];
  }
  return m;
})();

/** Internal adapter: a ProgressFn that patches the Job on disk. */
function makeProgressFn(queue: JobQueue, jobId: string): ProgressFn {
  return (stage, stageProgress, detail) => {
    if (queue.isCancellationRequested(jobId)) throw new Error('Job cancelled');
    const base = STAGE_BASE.get(stage) ?? 0;
    const weight = STAGE_WEIGHTS[stage as keyof typeof STAGE_WEIGHTS] ?? 0;
    const overall = Math.min(0.999, base + weight * Math.max(0, Math.min(1, stageProgress)));
    queue.update(jobId, {
      stage,
      progress: overall,
      message: detail ? `${stageMessage(stage)} — ${detail}` : stageMessage(stage),
    });
  };
}

/** A sanitized output filename for the produced BVH. */
function deriveOutputName(labelBase: string): string {
  const safe = labelBase.replace(/[^\w-]+/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '') || 'motion';
  return `${safe}.bvh`;
}

/**
 * Run the mocap pipeline against a concrete input file/dir with progress.
 *
 * This is the streaming counterpart to {@link runPipeline} in `pipeline.ts`.
 * It does NOT accept URLs directly — the worker resolves the concrete file
 * path before calling this, so progress for the download stage is separate.
 *
 * @param inputPath   Absolute path to a video file or frame directory.
 * @param outDir       Directory to write the final BVH into.
 * @param settings    User pipeline settings.
 * @param onProgress  Progress callback (called from the same thread).
 * @param verbose    Extra stderr logging (defaults to false).
 * @returns the path to the written BVH and the resolved fps.
 */
export async function runPipelineStreaming(
  inputPath: string,
  outDir: string,
  settings: JobSettings,
  onProgress: ProgressFn,
  verbose = false,
): Promise<{ bvhPath: string; fps: number; frameCount: number }> {
  if (!existsSync(inputPath)) {
    throw new Error(`Input not found: ${inputPath}`);
  }
  mkdirSync(outDir, { recursive: true });

  const stat = statSync(inputPath);
  const isDir = stat.isDirectory();

  // Stage: extract (skipped for frame dirs — frames already present).
  let framePaths: string[];
  let sourceFps: number | undefined;

  if (isDir) {
    onProgress(JobStage.EXTRACTING, 1, 'loading frame directory');
    framePaths = loadFrameDir(inputPath);
    if (framePaths.length === 0) {
      throw new Error(`No image files found in: ${inputPath}`);
    }
  } else {
    onProgress(JobStage.EXTRACTING, 0, 'extracting frames');
    const result = extractFrames(inputPath, { fps: settings.fps, verbose });
    framePaths = result.frames;
    sourceFps = result.sourceFps;
    onProgress(JobStage.EXTRACTING, 1, `${framePaths.length} frames`);
    if (framePaths.length === 0) {
      throw new Error('No frames extracted from video. Is ffmpeg installed?');
    }
  }

  const fps = settings.fps ?? sourceFps ?? 30;

  // Stage: estimate (single- or multi-person).
  onProgress(JobStage.ESTIMATING, 0, 'initializing estimator');
  const estimator = await createEstimator({
    hands: settings.hands,
    verbose,
    multipose: settings.multipose,
    backend: settings.backend,
  });
  // For multi-person we keep a per-person sequence (aligned by frame index).
  const poses: FramePose[] = [];
  const multiPersonPoses: Map<number, FramePose[]> = new Map(); // personId -> poses
  try {
    for (let i = 0; i < framePaths.length; i++) {
      if (i % 5 === 0) {
        onProgress(JobStage.ESTIMATING, i / framePaths.length, `frame ${i + 1}/${framePaths.length}`);
      }
      if (settings.multipose && estimator.estimateFrameMulti) {
        const people = await estimator.estimateFrameMulti(framePaths[i], i);
        for (const person of people) {
          const pid = (person as { personId?: number }).personId ?? 0;
          if (!multiPersonPoses.has(pid)) multiPersonPoses.set(pid, []);
          multiPersonPoses.get(pid)!.push(person);
        }
      } else {
        poses.push(await estimator.estimateFrame(framePaths[i], i));
      }
    }
    onProgress(JobStage.ESTIMATING, 1, `${poses.length || multiPersonPoses.size} poses`);
  } finally {
    estimator.close();
  }

  // Build the list of (label, sequence) to run downstream for. Single-person
  // is one sequence; multi-person is one sequence per detected person.
  const sequences: { label: string; seq: FramePose[] }[] = settings.multipose
    ? [...multiPersonPoses.entries()].map(([pid, seq]) => ({ label: `person${pid}`, seq }))
    : [{ label: 'motion', seq: poses }];
  if (sequences.length === 0 || sequences.every(s => s.seq.length === 0)) {
    throw new Error('No poses detected in any frame');
  }

  // Run smooth + calibrate + IK + write per sequence. For single-person this
  // is the original path; for multi-person each person becomes its own BVH.
  let lastBvhPath = '';
  let totalFrames = 0;
  for (let s = 0; s < sequences.length; s++) {
    const { label, seq } = sequences[s];
    if (seq.length === 0) continue;

  // Stage: smooth
  onProgress(JobStage.SMOOTHING, 0, sequences.length > 1 ? `${label} (${s + 1}/${sequences.length})` : undefined);
  const smoother = new TemporalSmoother(settings.smoothing);
  const smoothed = seq.map(p => smoother.smooth(p));
  onProgress(JobStage.SMOOTHING, 1, `${smoothed.length} frames`);

  // Stage: calibrate
  onProgress(JobStage.CALIBRATING, 0);
  const skeleton = calibrateSkeleton(smoothed, verbose);
  onProgress(JobStage.CALIBRATING, 1);

  // Stage: IK
  onProgress(JobStage.SOLVING_IK, 0);
  const ikFrames: IKFrame[] = [];
  let prev: Quat[] | undefined;
  const footLock = createFootLockState();
  const ikOptions = {
    minVisibility: settings.minVisibility,
    groundLockFeet: settings.groundLockFeet,
  };
  for (let i = 0; i < smoothed.length; i++) {
    if (i % 10 === 0) onProgress(JobStage.SOLVING_IK, i / smoothed.length);
    const frame = solveIK(smoothed[i], skeleton, prev, ikOptions, footLock);
    ikFrames.push(frame);
    prev = frame.localRotations;
  }
  onProgress(JobStage.SOLVING_IK, 1, `${ikFrames.length} frames`);

  // Stage: write motion file (BVH or FBX per settings.format)
  onProgress(JobStage.WRITING_BVH, 0);
  const format: MotionFormat = (settings.format ?? 'bvh') as MotionFormat;
  const labelBase = basename(inputPath, extname(inputPath));
  // For multi-person, disambiguate each output by person label.
  const suffix = sequences.length > 1 ? `_${label}` : '';
  const baseName = `${deriveOutputName(labelBase).replace(/\.(bvh|fbx)$/, '')}${suffix}`;
  const motionText = format === 'fbx'
    ? writeMotion(skeleton, ikFrames, fps, { format: 'fbx', name: baseName })
    : writeMotion(skeleton, ikFrames, fps, { format: 'bvh' });
  const outputName = format === 'fbx' ? `${baseName}.fbx` : `${baseName}.bvh`;
  const motionPath = join(outDir, outputName);
  writeFileSync(motionPath, motionText, 'utf-8');
  onProgress(JobStage.WRITING_BVH, 1, outputName);

  lastBvhPath = motionPath;
  totalFrames += framePaths.length;
  } // end per-sequence loop

  // Return the first person's output as the job's primary result.
  return { bvhPath: lastBvhPath, fps, frameCount: totalFrames };
}

/**
 * Resolve a job's input to a concrete local file path.
 *
 * - For uploads, the file is already on disk — return its path.
 * - For URLs, download via yt-dlp into a temp dir and return the path.
 *
 * Calls `onProgress` for the download stage so the UI can show "downloading".
 */
export async function resolveJobInput(
  job: Job,
  workDir: string,
  onProgress: ProgressFn,
  verbose = false,
): Promise<{ videoPath: string; title: string }> {
  if (job.source.kind === 'upload') {
    // `workDir` is the per-job directory: <data>/work/<job-id>.
    // Uploads live beside `work/`, at <data>/uploads.
    const uploadRoot = resolve(workDir, '..', '..', 'uploads');
    const uploadPath = resolve(job.source.path);
    if (uploadPath !== uploadRoot && !uploadPath.startsWith(`${uploadRoot}/`)) {
      throw new Error('Upload path is outside the managed data directory');
    }
    return { videoPath: uploadPath, title: job.source.filename };
  }
  await validateRemoteVideoUrl(job.source.url);
  onProgress(JobStage.DOWNLOADING, 0, 'fetching video metadata');
  const result = downloadVideo(job.source.url, { outDir: workDir, verbose });
  onProgress(JobStage.DOWNLOADING, 1, result.title);
  return { videoPath: result.videoPath, title: result.title };
}

/**
 * Run a single job end-to-end: resolve input, stream the pipeline, finalize.
 *
 * Throws on failure; the caller ({@link startWorkerLoop}) catches and marks
 * the job failed.
 */
export async function runJob(queue: JobQueue, job: Job, dirs: {
  workDir: string;
  outDir: string;
  verbose?: boolean;
}): Promise<void> {
  const onProgress = makeProgressFn(queue, job.id);

  const jobWorkDir = join(dirs.workDir, job.id);
  const jobOutDir = join(dirs.outDir, job.id);
  mkdirSync(jobWorkDir, { recursive: true });
  mkdirSync(jobOutDir, { recursive: true });
  const { videoPath, title } = await resolveJobInput(job, jobWorkDir, onProgress, dirs.verbose);
  if (queue.isCancellationRequested(job.id)) throw new Error('Job cancelled');
  const { bvhPath, frameCount } = await runPipelineStreaming(
    videoPath,
    jobOutDir,
    job.settings,
    onProgress,
    dirs.verbose,
  );

  if (queue.isCancellationRequested(job.id)) throw new Error('Job cancelled');
  queue.update(job.id, {
    stage: JobStage.DONE,
    progress: 1,
    message: `Done — ${frameCount} frames`,
    outputName: basename(bvhPath),
    outputBvhPath: bvhPath,
    finishedAt: new Date().toISOString(),
  });
}

/**
 * Start a worker loop: poll the queue, claim + run jobs until stopped.
 *
 * `signal` lets the caller request a graceful stop after the current job.
 *
 * The loop is deliberately single-threaded: TF.js pose estimation is
 * CPU-heavy and a single MoveNet run saturates a core. Scale horizontally
 * by running more worker processes against a shared queue provider later.
 */
export async function startWorkerLoop(
  queue: JobQueue,
  dirs: { workDir: string; outDir: string; verbose?: boolean },
  signal?: { stopped: boolean },
): Promise<void> {
  // Ensure scratch dirs exist.
  mkdirSync(dirs.workDir, { recursive: true });
  mkdirSync(dirs.outDir, { recursive: true });

  while (!signal?.stopped) {
    const job = queue.acquireNext();
    if (!job) {
      await sleep(1000);
      continue;
    }
    try {
      await runJob(queue, job, dirs);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      try {
        queue.fail(job.id, message);
      } catch {
        // queue failure is best-effort
      }
      if (dirs.verbose) console.error(`[mocap-ts worker] job ${job.id} failed: ${message}`);
    }
    // Clean up scratch data after every attempt. Failed or cancelled attempts
    // must not leave partial artifacts that a later retry could expose.
    const scratch = join(dirs.workDir, job.id);
    rmSync(scratch, { force: true, recursive: true });
    if (queue.get(job.id)?.stage !== JobStage.DONE) {
      rmSync(join(dirs.outDir, job.id), { force: true, recursive: true });
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Re-export for callers that want to build their own runPipeline-like helper.
export type { CliOptions };
export { stageMessage };
