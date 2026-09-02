/**
 * Motion-production workspace contracts.
 *
 * These types describe the product domain, not a database schema or a
 * framework API. They are intentionally JSON-serializable so the web app,
 * worker services, editor, render service, and future integrations can share
 * the same vocabulary without coupling to a storage provider.
 *
 * Product hierarchy:
 *   Organization -> Workspace -> Project -> Capture/Take -> Shot/Timeline
 *   -> Character/Scene -> Render/Export/Review
 */

export type Id = string;
export type IsoDate = string;

/** A durable object stored in S3, MinIO, or another object store. */
export interface AssetRef {
  id: Id;
  objectKey: string;
  provider: string;
  bucket?: string;
  contentType: string;
  byteSize: number;
  checksum?: string;
  checksumAlgorithm?: 'sha256' | 'md5' | 'crc32c';
  createdAt: IsoDate;
  /** Never persist a signed URL; issue one at request time. */
  originalFilename?: string;
}

export const WorkspaceRole = {
  OWNER: 'owner',
  ADMIN: 'admin',
  EDITOR: 'editor',
  REVIEWER: 'reviewer',
  VIEWER: 'viewer',
} as const;

export type WorkspaceRole = (typeof WorkspaceRole)[keyof typeof WorkspaceRole];

export interface Organization {
  id: Id;
  name: string;
  slug: string;
  createdAt: IsoDate;
}

export interface Workspace {
  id: Id;
  organizationId: Id;
  name: string;
  slug: string;
  createdAt: IsoDate;
  updatedAt: IsoDate;
}

export interface WorkspaceMembership {
  workspaceId: Id;
  userId: Id;
  role: WorkspaceRole;
  createdAt: IsoDate;
}

export interface Project {
  id: Id;
  workspaceId: Id;
  name: string;
  slug: string;
  description?: string;
  frameRate?: number;
  unit: 'centimeter' | 'meter';
  createdAt: IsoDate;
  updatedAt: IsoDate;
}

/** State of the source footage and its preprocessing lifecycle. */
export const CaptureStatus = {
  CREATED: 'created',
  UPLOADING: 'uploading',
  READY: 'ready',
  PROCESSING: 'processing',
  COMPLETE: 'complete',
  FAILED: 'failed',
  DELETED: 'deleted',
} as const;

export type CaptureStatus = (typeof CaptureStatus)[keyof typeof CaptureStatus];

export type CaptureInput =
  | {
      kind: 'upload';
      assetId: Id;
      originalFilename: string;
    }
  | {
      kind: 'remote-url';
      url: string;
      provider?: string;
    }
  | {
      kind: 'multicam';
      cameraAssetIds: Id[];
      timecodeStart?: string;
      synchronizationAssetId?: Id;
    };

export interface Capture {
  id: Id;
  projectId: Id;
  name: string;
  status: CaptureStatus;
  input: CaptureInput;
  durationSeconds?: number;
  sourceFrameRate?: number;
  width?: number;
  height?: number;
  hasAudio?: boolean;
  createdBy: Id;
  createdAt: IsoDate;
  updatedAt: IsoDate;
}

/** A repeatable model + processing configuration used for a capture run. */
export interface ProcessingProfile {
  id: Id;
  name: string;
  poseBackend: string;
  poseModel: string;
  trackingMode: 'single-person' | 'multi-person';
  bodyTracking: boolean;
  handTracking: boolean;
  faceTracking: boolean;
  depthEstimation: boolean;
  smoothing: {
    method: string;
    strength: number;
  };
  contactSolving: {
    footLock: boolean;
    handGroundContact: boolean;
  };
  createdAt: IsoDate;
  updatedAt: IsoDate;
}

export const MotionTakeStatus = {
  QUEUED: 'queued',
  RUNNING: 'running',
  REVIEW: 'review',
  APPROVED: 'approved',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
} as const;

export type MotionTakeStatus = (typeof MotionTakeStatus)[keyof typeof MotionTakeStatus];

export interface MotionQualityReport {
  score?: number;
  trackedFrameRatio: number;
  lowConfidenceFrameRatio: number;
  occludedFrameRatio: number;
  footContactConfidence?: number;
  bodyConfidence?: number;
  warnings: string[];
  modelVersion: string;
}

/** The canonical result of turning footage into reusable motion data. */
export interface MotionTake {
  id: Id;
  projectId: Id;
  captureId?: Id;
  parentTakeId?: Id;
  name: string;
  status: MotionTakeStatus;
  processingProfileId: Id;
  frameRate: number;
  frameStart: number;
  frameEnd: number;
  durationSeconds: number;
  motionAssetId?: Id;
  skeletonAssetId?: Id;
  quality?: MotionQualityReport;
  createdBy: Id;
  createdAt: IsoDate;
  updatedAt: IsoDate;
}

export const CharacterAssetStatus = {
  UPLOADING: 'uploading',
  VALIDATING: 'validating',
  READY: 'ready',
  FAILED: 'failed',
} as const;

export type CharacterAssetStatus = (typeof CharacterAssetStatus)[keyof typeof CharacterAssetStatus];

export interface RigDefinition {
  id: Id;
  name: string;
  sourceFormat: 'gltf' | 'glb' | 'fbx' | 'usd' | 'other';
  rootBone: string;
  boneNames: string[];
  restPose: 't-pose' | 'a-pose' | 'custom' | 'unknown';
  unit: 'centimeter' | 'meter' | 'unknown';
  axisConvention: string;
  mappingVersion: string;
  validationWarnings: string[];
}

export interface CharacterAsset {
  id: Id;
  projectId: Id;
  name: string;
  status: CharacterAssetStatus;
  modelAssetId: Id;
  thumbnailAssetId?: Id;
  rig: RigDefinition;
  createdBy: Id;
  createdAt: IsoDate;
  updatedAt: IsoDate;
}

export interface SceneEnvironment {
  kind: 'preset' | 'asset' | 'procedural';
  assetId?: Id;
  presetId?: string;
  settings?: Record<string, string | number | boolean>;
}

export interface Scene {
  id: Id;
  projectId: Id;
  name: string;
  environment: SceneEnvironment;
  camera?: CameraConfig;
  createdBy: Id;
  createdAt: IsoDate;
  updatedAt: IsoDate;
}

export interface CameraConfig {
  projection: 'perspective' | 'orthographic';
  position: [number, number, number];
  target: [number, number, number];
  focalLength?: number;
  fieldOfView?: number;
}

export interface Transform {
  position: [number, number, number];
  rotation: [number, number, number, number];
  scale: [number, number, number];
}

export interface MotionClip {
  id: Id;
  takeId: Id;
  sourceIn: number;
  sourceOut: number;
  timelineIn: number;
  speed: number;
  loop: boolean;
  blendInFrames: number;
  blendOutFrames: number;
  rootTransform?: Transform;
}

export interface CharacterTrack {
  id: Id;
  characterAssetId: Id;
  clips: MotionClip[];
  transform: Transform;
  visible: boolean;
  muted: boolean;
}

export interface SceneTrack {
  id: Id;
  sceneId: Id;
  startFrame: number;
  endFrame: number;
  visible: boolean;
}

/** Non-destructive timeline state for the 3D video workspace. */
export interface Timeline {
  id: Id;
  projectId: Id;
  name: string;
  frameRate: number;
  durationFrames: number;
  sceneTracks: SceneTrack[];
  characterTracks: CharacterTrack[];
  createdBy: Id;
  createdAt: IsoDate;
  updatedAt: IsoDate;
}

export const RenderStatus = {
  QUEUED: 'queued',
  RUNNING: 'running',
  COMPLETE: 'complete',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
} as const;

export type RenderStatus = (typeof RenderStatus)[keyof typeof RenderStatus];

export interface RenderSpec {
  format: 'mp4' | 'webm' | 'image-sequence';
  width: number;
  height: number;
  frameRate: number;
  codec?: string;
  quality?: number;
  includeAudio: boolean;
}

export interface RenderJob {
  id: Id;
  timelineId: Id;
  status: RenderStatus;
  spec: RenderSpec;
  outputAssetId?: Id;
  progress: number;
  error?: string;
  createdBy: Id;
  createdAt: IsoDate;
  finishedAt?: IsoDate;
}

export const ExportFormat = {
  BVH: 'bvh',
  FBX: 'fbx',
  GLB: 'glb',
  USD: 'usd',
  C3D: 'c3d',
} as const;

export type ExportFormat = (typeof ExportFormat)[keyof typeof ExportFormat];

export interface MotionExport {
  id: Id;
  takeId: Id;
  characterAssetId?: Id;
  format: ExportFormat;
  status: RenderStatus;
  outputAssetId?: Id;
  createdBy: Id;
  createdAt: IsoDate;
}

export const ReviewStatus = {
  OPEN: 'open',
  CHANGES_REQUESTED: 'changes_requested',
  APPROVED: 'approved',
  RESOLVED: 'resolved',
} as const;

export type ReviewStatus = (typeof ReviewStatus)[keyof typeof ReviewStatus];

export interface ReviewComment {
  id: Id;
  projectId: Id;
  authorId: Id;
  targetType: 'capture' | 'motion-take' | 'timeline' | 'render' | 'character';
  targetId: Id;
  frame?: number;
  body: string;
  status: ReviewStatus;
  createdAt: IsoDate;
  updatedAt: IsoDate;
}

/** Immutable version pointer used for reproducibility and approval. */
export interface VersionSnapshot {
  id: Id;
  projectId: Id;
  entityType: 'motion-take' | 'timeline' | 'character' | 'scene' | 'render';
  entityId: Id;
  version: number;
  snapshotAssetId?: Id;
  sourceVersion?: string;
  processingProfileId?: Id;
  createdBy: Id;
  createdAt: IsoDate;
}

/** Commands emitted by the control plane to the processing plane. */
export type ProcessingCommand =
  | {
      kind: 'process-capture';
      projectId: Id;
      captureId: Id;
      motionTakeId: Id;
      processingProfileId: Id;
    }
  | {
      kind: 'retarget-motion';
      projectId: Id;
      motionTakeId: Id;
      characterAssetId: Id;
      exportFormat: ExportFormat;
    }
  | {
      kind: 'render-timeline';
      projectId: Id;
      timelineId: Id;
      renderJobId: Id;
    };
