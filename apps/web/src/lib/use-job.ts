'use client';

import { useEffect, useState, useCallback } from 'react';
// ClientJob is a local type — no core import here, so this file stays out of the TF bundle.
import type { ClientJob } from './types';

/**
 * Subscribe to a job's lifecycle: initial GET, then an SSE stream for
 * live progress. Falls back to polling if EventSource is unavailable.
 *
 * Returns `job`, `error`, and `isTerminal`.
 */
export function useJob(jobId: string | null): {
  job: ClientJob | null;
  error: string | null;
  isTerminal: boolean;
  reload: () => void;
} {
  const [job, setJob] = useState<ClientJob | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  const reload = useCallback(() => setTick(t => t + 1), []);

  useEffect(() => {
    if (!jobId) return;
    let cancelled = false;
    let es: EventSource | null = null;
    let pollTimer: ReturnType<typeof setInterval> | null = null;

    // Initial fetch.
    fetch(`/api/jobs/${jobId}`)
      .then(r => (r.ok ? r.json() : Promise.reject(new Error('not found'))))
      .then(data => {
        if (!cancelled) setJob(data.job);
      })
      .catch(e => {
        if (!cancelled) setError(e instanceof Error ? e.message : 'failed to load');
      });

    // SSE for live updates.
    if (typeof EventSource !== 'undefined') {
      es = new EventSource(`/api/jobs/${jobId}/events`);
      es.addEventListener('progress', e => {
        if (cancelled) return;
        try {
          setJob(JSON.parse((e as MessageEvent).data));
        } catch { /* ignore parse errors */ }
      });
      es.addEventListener('complete', e => {
        if (cancelled) return;
        try {
          setJob(JSON.parse((e as MessageEvent).data));
        } catch { /* ignore */ }
        es?.close();
      });
      es.onerror = () => {
        // Don't surface transient network blips as hard errors; the initial
        // fetch already established whether the job exists.
        es?.close();
      };
    } else {
      // Polling fallback.
      pollTimer = setInterval(async () => {
        const r = await fetch(`/api/jobs/${jobId}`);
        if (!r.ok) return;
        const data = await r.json();
        if (!cancelled) setJob(data.job);
      }, 1500);
    }

    return () => {
      cancelled = true;
      es?.close();
      if (pollTimer) clearInterval(pollTimer);
    };
  }, [jobId, tick]);

  const isTerminal = job != null && ['done', 'failed', 'cancelled'].includes(job.stage);
  return { job, error, isTerminal, reload };
}
