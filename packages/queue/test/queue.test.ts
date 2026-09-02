import { describe, expect, it } from 'vitest';
import { MotionQueueEvents } from '../src/index.js';

describe('MotionQueueEvents', () => {
  it('delivers typed progress events to subscribers', () => {
    const events = new MotionQueueEvents();
    const received: string[] = [];
    events.onProgress(event => received.push(`${event.jobId}:${event.progress}`));
    events.emitProgress({ jobId: 'job-1', stage: 'estimating', progress: 0.5, timestamp: Date.now() });
    expect(received).toEqual(['job-1:0.5']);
  });
});
