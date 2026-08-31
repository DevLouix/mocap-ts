import type { JobStage } from '@mocap-ts/core/jobs/queue';

/**
 * Canonical execution order of pipeline stages, used by the timeline UI.
 * Matches the stage weights in packages/core/src/jobs/runner.ts.
 * `queued`/`done`/`failed`/`cancelled` are lifecycle bookends, not steps.
 */
export const STAGE_ORDER: JobStage[] = [
  'queued',
  'downloading',
  'extracting',
  'estimating',
  'smoothing',
  'calibrating',
  'solving_ik',
  'writing_bvh',
  'done',
];
