export interface MultipartSession {
  sessionId: string;
  partSize: number;
  partCount: number;
  expiresAt: string;
}

interface MultipartStatus extends MultipartSession {
  status: 'active' | 'completed' | 'aborted' | 'expired' | string;
  uploadedParts: number[];
  uploadedBytes: number;
  filename: string;
  sizeBytes: number;
  jobId?: string;
}

export interface UploadProgress {
  uploadedBytes: number;
  totalBytes: number;
  partNumber: number;
}

const MAX_RETRIES = 4;
const CONCURRENCY = 3;

export class ResumableUploadUnavailableError extends Error {
  constructor() {
    super('Resumable uploads require durable persistence mode');
    this.name = 'ResumableUploadUnavailableError';
  }
}

/**
 * Upload a video directly to S3-compatible storage in resumable parts.
 * A local session reference is retained until the server accepts completion;
 * retrying the same File object resumes only the missing parts.
 */
export async function uploadVideoResumably(
  file: File,
  settings: Record<string, unknown>,
  onProgress?: (progress: UploadProgress) => void,
  signal?: AbortSignal,
): Promise<{ job: { id: string } }> {
  const storageKey = sessionStorageKey(file, settings);
  let session = await findResumableSession(storageKey, file, signal);
  if (!session) {
    session = await postJson<MultipartSession>('/api/uploads', {
      filename: file.name,
      mimeType: file.type || undefined,
      sizeBytes: file.size,
      settings,
    }, signal);
    saveSession(storageKey, session);
  }

  const status = await getSessionStatus(session.sessionId, signal);
  if (status && status.status !== 'active') {
    removeSession(storageKey);
    if (status.status === 'completed' && status.jobId) return { job: { id: status.jobId } };
    throw new Error('Upload session is no longer active');
  }

  const uploaded = new Set(status?.uploadedParts ?? []);
  let uploadedBytes = status?.uploadedBytes ?? 0;
  onProgress?.({ uploadedBytes, totalBytes: file.size, partNumber: 0 });

  const uploadPart = async (partNumber: number): Promise<void> => {
    if (uploaded.has(partNumber)) return;
    const start = (partNumber - 1) * session!.partSize;
    const end = Math.min(file.size, start + session!.partSize);
    const body = file.slice(start, end);
    let lastError: unknown;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        const signed = await postJson<{ url: string }>(
          `/api/uploads/${encodeURIComponent(session!.sessionId)}/parts/${partNumber}`,
          {},
          signal,
        );
        const response = await fetch(signed.url, { method: 'PUT', body, signal });
        if (!response.ok) throw new Error(`Part upload failed (${response.status})`);
        uploaded.add(partNumber);
        uploadedBytes += body.size;
        onProgress?.({ uploadedBytes, totalBytes: file.size, partNumber });
        return;
      } catch (error) {
        if (signal?.aborted) throw error;
        lastError = error;
        await delay(500 * 2 ** attempt, signal);
      }
    }
    throw lastError instanceof Error ? lastError : new Error('Part upload failed');
  };

  let nextPart = 1;
  const worker = async (): Promise<void> => {
    while (nextPart <= session!.partCount) {
      const partNumber = nextPart++;
      if (!uploaded.has(partNumber)) await uploadPart(partNumber);
    }
  };

  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, session.partCount) }, worker));
  try {
    const result = await postJson<{ job: { id: string } }>(
      `/api/uploads/${encodeURIComponent(session.sessionId)}/complete`,
      {},
      signal,
    );
    removeSession(storageKey);
    return result;
  } catch (error) {
    // Keep the session reference. A subsequent attempt can query status and
    // upload only missing parts. The explicit DELETE endpoint remains the
    // operator/user escape hatch for abandoning an upload.
    throw error;
  }
}

async function findResumableSession(key: string, file: File, signal?: AbortSignal): Promise<MultipartSession | null> {
  if (typeof window === 'undefined') return null;
  const raw = window.localStorage.getItem(key);
  if (!raw) return null;
  try {
    const session = JSON.parse(raw) as MultipartSession;
    if (!session.sessionId || Date.parse(session.expiresAt) <= Date.now()) {
      removeSession(key);
      return null;
    }
    const status = await getSessionStatus(session.sessionId, signal);
    if (!status) {
      removeSession(key);
      return null;
    }
    if (status.status !== 'active' || status.filename !== file.name || status.sizeBytes !== file.size) {
      removeSession(key);
      return null;
    }
    return session;
  } catch {
    removeSession(key);
    return null;
  }
}

async function getSessionStatus(sessionId: string, signal?: AbortSignal): Promise<MultipartStatus | null> {
  const response = await fetch(`/api/uploads/${encodeURIComponent(sessionId)}`, { signal });
  if (response.status === 404 || response.status === 409) return null;
  const payload = await response.json().catch(() => null) as { error?: string } | MultipartStatus | null;
  if (!response.ok) {
    const message = payload && typeof payload === 'object' && 'error' in payload ? payload.error : undefined;
    throw new Error(message ?? `Upload status failed (${response.status})`);
  }
  return payload as MultipartStatus;
}

async function postJson<T>(url: string, body: unknown, signal?: AbortSignal): Promise<T> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });
  const payload = await response.json().catch(() => null) as { error?: string } | T | null;
  if (!response.ok) {
    if (response.status === 409 && url === '/api/uploads') throw new ResumableUploadUnavailableError();
    const message = payload && typeof payload === 'object' && 'error' in payload ? payload.error : undefined;
    throw new Error(message ?? `Request failed (${response.status})`);
  }
  return payload as T;
}

function sessionStorageKey(file: File, settings: Record<string, unknown>): string {
  const settingsKey = JSON.stringify(settings);
  return `mocap:multipart:${file.name}:${file.size}:${file.lastModified}:${settingsKey}`;
}

function saveSession(key: string, session: MultipartSession): void {
  if (typeof window !== 'undefined') window.localStorage.setItem(key, JSON.stringify(session));
}

function removeSession(key: string): void {
  if (typeof window !== 'undefined') window.localStorage.removeItem(key);
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(signal.reason ?? new Error('Upload cancelled'));
    }, { once: true });
  });
}
