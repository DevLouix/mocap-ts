/**
 * Mocap job lifecycle types.
 *
 * These are the shared contracts between:
 *   - the API layer (Next.js route handlers submit + poll jobs)
 *   - the queue provider (in-process file-backed by default; swappable for
 *     Inngest / BullMQ / Redis later)
 *   - the worker (runs the mocap pipeline and emits progress)
 *
 * Everything here is plain JSON-serializable so it can travel over SSE,
 * localStorage, or a DB row without adapters.
 */

/** Stable list of pipeline stages, in execution order. */
export const JobStage = {
  QUEUED: 'queued',
  DOWNLOADING: 'downloading',
  EXTRACTING: 'extracting',
  ESTIMATING: 'estimating',
  SMOOTHING: 'smoothing',
  CALIBRATING: 'calibrating',
  SOLVING_IK: 'solving_ik',
  WRITING_BVH: 'writing_bvh',
  DONE: 'done',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
} as const;

export type JobStage = (typeof JobStage)[keyof typeof JobStage];

/** Terminal stages — once reached the worker stops touching the job. */
const TERMINAL_STAGES = new Set<JobStage>([
  JobStage.DONE,
  JobStage.FAILED,
  JobStage.CANCELLED,
]);

export function isTerminalStage(stage: JobStage): boolean {
  return TERMINAL_STAGES.has(stage);
}

/** A single progress event emitted while a job runs. */
export interface JobProgress {
  /** Current stage. */
  stage: JobStage;
  /** Human-readable label for the current stage. */
  message: string;
  /** 0..1 overall completion (across the whole pipeline). */
  progress: number;
  /** Optional per-stage detail, e.g. "frame 42/120". */
  detail?: string;
  /** Epoch millis the event was produced. */
  timestamp: number;
}

/** How a job was submitted. */
export type JobSource =
  | { kind: 'upload'; /** Original filename as uploaded. */ filename: string; /** Absolute path to the saved file. */ path: string; /** Mime type if known. */ mimeType?: string; /** Size in bytes. */ sizeBytes?: number }
  | { kind: 'url'; /** Remote video URL (YouTube, etc). */ url: string };

/** User-tunable pipeline settings, mirrored from the CLI flags. */
export interface JobSettings {
  /** Frame extraction rate. `undefined` = use source fps. */
  fps?: number;
  /** Include hand tracking (MoveNet ignores this, kept for future backends). */
  hands: boolean;
  /** EMA smoothing alpha, 0..1. */
  smoothing: number;
  /** Output motion format. Defaults to 'bvh'. */
  format?: 'bvh' | 'fbx';
  /** Minimum keypoint visibility (0..1) for confidence-weighted IK. Default 0.3. */
  minVisibility?: number;
  /** Enable foot-contact ground-locking to prevent foot slide. */
  groundLockFeet?: boolean;
  /** Enable multi-person tracking (one output BVH per person). */
  multipose?: boolean;
  /** Backend: 'cpu' (default) or 'webgpu' (experimental browser path). */
  backend?: 'cpu' | 'webgpu';
}

export const DEFAULT_JOB_SETTINGS: JobSettings = {
  fps: undefined,
  hands: false,
  smoothing: 0.7,
};

/** Tenant context attached to every submitted processing job. */
export interface JobTenantContext {
  organizationId: string;
  workspaceId: string;
  createdBy: string;
}

/** Everything the queue + worker need to know to run a job. */
export interface Job {
  id: string;
  /** ISO timestamp the job was created. */
  createdAt: string;
  /** Tenant boundary for every job and derived artifact. */
  organizationId: string;
  workspaceId: string;
  /** Principal that submitted the job. */
  createdBy: string;
  /** Number of worker attempts, starting at 1 when claimed. */
  attempt: number;
  /** Maximum number of attempts before the job is terminally failed. */
  maxAttempts: number;
  source: JobSource;
  settings: JobSettings;
  /** Current lifecycle stage. */
  stage: JobStage;
  /** Rolling progress for the current run. */
  progress: number;
  /** Optional human-readable message for the current stage. */
  message?: string;
  /** Output filename (with .bvh). Set once the pipeline writes output. */
  outputName?: string;
  /** Absolute path to the produced motion file on disk (worker-only, never serialized to the client). */
  outputBvhPath?: string;
  /** If stage === 'failed', the error message. */
  error?: string;
  /** When the job reached a terminal stage. */
  finishedAt?: string;
  /** Rolling log of recent progress events (capped by the queue provider). */
  history: JobProgress[];
  /** ISO timestamp of the current worker lease, when claimed. */
  leasedAt?: string;
  /** True when cancellation was requested while work was running. */
  cancelRequested?: boolean;
}

/** A snapshot used to list jobs in the UI. Cheaper than the full Job. */
export interface JobSummary {
  id: string;
  organizationId: string;
  workspaceId: string;
  createdBy: string;
  createdAt: string;
  label: string;
  stage: JobStage;
  progress: number;
  outputName?: string;
  error?: string;
  finishedAt?: string;
}

/** Human-friendly label for a job, derived from its source. */
export function jobLabel(job: Pick<Job, 'source' | 'id'>): string {
  if (job.source.kind === 'upload') {
    return job.source.filename.replace(/\.[^.]+$/, '') || job.id;
  }
  try {
    const url = new URL(job.source.url);
    const seg = url.pathname.split('/').filter(Boolean).pop();
    return seg || job.source.url;
  } catch {
    return job.source.url;
  }
}

/** A human-readable default message for each stage. */
export function stageMessage(stage: JobStage): string {
  switch (stage) {
    case JobStage.QUEUED: return 'Queued';
    case JobStage.DOWNLOADING: return 'Downloading video';
    case JobStage.EXTRACTING: return 'Extracting frames';
    case JobStage.ESTIMATING: return 'Estimating poses';
    case JobStage.SMOOTHING: return 'Smoothing';
    case JobStage.CALIBRATING: return 'Calibrating skeleton';
    case JobStage.SOLVING_IK: return 'Solving inverse kinematics';
    case JobStage.WRITING_BVH: return 'Writing BVH';
    case JobStage.DONE: return 'Done';
    case JobStage.FAILED: return 'Failed';
    case JobStage.CANCELLED: return 'Cancelled';
  }
}
