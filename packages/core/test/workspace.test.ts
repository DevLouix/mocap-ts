import { describe, expect, it } from 'vitest';
import {
  CaptureStatus,
  CharacterAssetStatus,
  ExportFormat,
  MotionTakeStatus,
  RenderStatus,
  ReviewStatus,
  WorkspaceRole,
} from '../src/workspace/index.js';

describe('motion workspace contracts', () => {
  it('exposes the collaboration roles used by the control plane', () => {
    expect(Object.values(WorkspaceRole)).toEqual([
      'owner',
      'admin',
      'editor',
      'reviewer',
      'viewer',
    ]);
  });

  it('exposes lifecycle states for captures, takes, renders and review', () => {
    expect(CaptureStatus.COMPLETE).toBe('complete');
    expect(MotionTakeStatus.REVIEW).toBe('review');
    expect(CharacterAssetStatus.READY).toBe('ready');
    expect(RenderStatus.COMPLETE).toBe('complete');
    expect(ReviewStatus.CHANGES_REQUESTED).toBe('changes_requested');
  });

  it('keeps export formats explicit for integrations', () => {
    expect(Object.values(ExportFormat)).toEqual(['bvh', 'fbx', 'glb', 'usd', 'c3d']);
  });
});
