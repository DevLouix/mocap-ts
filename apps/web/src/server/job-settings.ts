import { DEFAULT_JOB_SETTINGS, type JobSettings } from '@mocap-ts/core/jobs/queue';

export function parseJobSettings(input: Record<string, unknown> | FormData): JobSettings {
  const get = (key: string): unknown => input instanceof FormData ? input.get(key) : input[key];

  let fps: number | undefined;
  const rawFps = get('fps');
  if (rawFps != null && rawFps !== '') {
    const value = Number(rawFps);
    if (Number.isFinite(value) && value > 0 && value <= 240) fps = value;
  }

  const rawHands = get('hands');
  const hands = rawHands == null ? DEFAULT_JOB_SETTINGS.hands : String(rawHands) !== 'false';

  let smoothing = DEFAULT_JOB_SETTINGS.smoothing;
  const rawSmoothing = get('smoothing');
  if (rawSmoothing != null && rawSmoothing !== '') {
    const value = Number(rawSmoothing);
    if (Number.isFinite(value) && value >= 0 && value <= 1) smoothing = value;
  }

  const rawFormat = get('format');
  const format = rawFormat === 'fbx' ? 'fbx' : rawFormat === 'bvh' ? 'bvh' : undefined;

  let minVisibility: number | undefined;
  const rawMinVisibility = get('minVisibility');
  if (rawMinVisibility != null && rawMinVisibility !== '') {
    const value = Number(rawMinVisibility);
    if (Number.isFinite(value) && value >= 0 && value <= 1) minVisibility = value;
  }

  const rawGroundLock = get('groundLockFeet');
  const groundLockFeet = rawGroundLock == null ? false : String(rawGroundLock) === 'true';
  const rawMultipose = get('multipose');
  const multipose = rawMultipose == null ? false : String(rawMultipose) === 'true';

  return { fps, hands, smoothing, format, minVisibility, groundLockFeet, multipose };
}
