import type { JobStage } from '@mocap-ts/core/jobs/queue';
import type { BadgeProps } from '@/components/ui/badge';

/** Human-friendly label for a stage. */
export function stageLabel(stage: JobStage): string {
  switch (stage) {
    case 'queued': return 'Queued';
    case 'downloading': return 'Downloading';
    case 'extracting': return 'Extracting';
    case 'estimating': return 'Estimating';
    case 'smoothing': return 'Smoothing';
    case 'calibrating': return 'Calibrating';
    case 'solving_ik': return 'Solving IK';
    case 'writing_bvh': return 'Writing BVH';
    case 'done': return 'Done';
    case 'failed': return 'Failed';
    case 'cancelled': return 'Cancelled';
  }
}

/** Badge variant reflecting a stage's tone. */
export function stageVariant(stage: JobStage): BadgeProps['variant'] {
  switch (stage) {
    case 'done': return 'success';
    case 'failed': return 'danger';
    case 'cancelled': return 'warning';
    case 'queued': return 'neutral';
    default: return 'accent';
  }
}
