'use client';

import { useState, useRef, useCallback } from 'react';
import { ResumableUploadUnavailableError, uploadVideoResumably } from '@/lib/resumable-upload';
import { useRouter } from 'next/navigation';
import { WorkspaceShell } from '@/components/layout/workspace-shell';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '@/components/ui/select';
import { Upload, Link2, Loader2, Film, AlertCircle } from 'lucide-react';
import { cn, formatBytes } from '@/lib/utils';

const ALLOWED_EXTS = ['.mp4', '.mov', '.mkv', '.webm', '.avi', '.m4v'];

export default function NewCapturePage() {
  const router = useRouter();
  const [submitting, setSubmitting] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const uploadAbortRef = useRef<AbortController | null>(null);

  // Upload state.
  const [file, setFile] = useState<File | null>(null);
  const [dragActive, setDragActive] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // URL state.
  const [url, setUrl] = useState('');

  // Settings.
  const [smoothing, setSmoothing] = useState(0.7);
  const [hands, setHands] = useState(false);
  const [fps, setFps] = useState('');
  const [format, setFormat] = useState<'bvh' | 'fbx'>('bvh');
  const [minVisibility, setMinVisibility] = useState('0.3');
  const [groundLockFeet, setGroundLockFeet] = useState(false);
  const [multipose, setMultipose] = useState(false);

  const onDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragActive(false);
    const f = e.dataTransfer.files?.[0];
    if (f) validateAndSetFile(f);
  }, []);

  const validateAndSetFile = (f: File) => {
    const ext = f.name.slice(f.name.lastIndexOf('.')).toLowerCase();
    if (!ALLOWED_EXTS.includes(ext)) {
      setError(`Unsupported file type ${ext}. Allowed: ${ALLOWED_EXTS.join(', ')}`);
      return;
    }
    if (f.size > 1024 * 1024 * 1024) {
      setError('File too large (max 1 GB)');
      return;
    }
    setError(null);
    setFile(f);
  };

  const submitUpload = async () => {
    if (!file) return;
    setSubmitting(true);
    setUploadProgress(0);
    setError(null);
    const settings = {
      smoothing,
      hands,
      format,
      fps: fps ? Number(fps) : undefined,
      minVisibility: Number(minVisibility),
      groundLockFeet,
      multipose,
    };
    const controller = new AbortController();
    uploadAbortRef.current = controller;
    const fd = new FormData();
    fd.append('file', file);
    fd.append('smoothing', String(smoothing));
    fd.append('hands', String(hands));
    fd.append('format', format);
    fd.append('minVisibility', minVisibility);
    fd.append('groundLockFeet', String(groundLockFeet));
    fd.append('multipose', String(multipose));
    if (fps) fd.append('fps', fps);
    try {
      // Durable mode uses direct multipart uploads. File mode answers with a
      // specific 409, in which case retain the legacy server-upload path.
      let result: { job: { id: string } };
      try {
        result = await uploadVideoResumably(
          file,
          settings,
          progress => setUploadProgress(progress.uploadedBytes / progress.totalBytes),
          controller.signal,
        );
      } catch (uploadError) {
        if (!(uploadError instanceof ResumableUploadUnavailableError)) throw uploadError;
        const r = await fetch('/api/jobs', { method: 'POST', body: fd, signal: controller.signal });
        const data = await r.json();
        if (!r.ok) throw new Error(data.error ?? 'Failed to submit');
        result = data;
      }
      router.push(`/jobs/${result.job.id}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to submit');
      setSubmitting(false);
      setUploadProgress(null);
    } finally {
      uploadAbortRef.current = null;
    }
  };

  const submitUrl = async () => {
    if (!url.trim()) return;
    setSubmitting(true);
    setError(null);
    try {
      const r = await fetch('/api/jobs', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ url, smoothing, hands, format, fps: fps ? Number(fps) : undefined, minVisibility: Number(minVisibility), groundLockFeet, multipose }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error ?? 'Failed to submit');
      router.push(`/jobs/${data.job.id}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to submit');
      setSubmitting(false);
    }
  };

  return (
    <WorkspaceShell active="new">
      <div className="mx-auto w-full max-w-2xl px-8 py-10">
        <header className="mb-6">
          <h1 className="text-2xl font-bold tracking-tight">New capture</h1>
          <p className="mt-1 text-sm text-ink-muted">
            Upload a video or paste a link. Pose estimation runs server-side — you'll get a BVH to download and preview.
          </p>
        </header>

        <Tabs defaultValue="upload" className="w-full">
          <TabsList className="mb-4">
            <TabsTrigger value="upload"><Upload className="mr-1.5 h-3.5 w-3.5" /> Upload</TabsTrigger>
            <TabsTrigger value="url"><Link2 className="mr-1.5 h-3.5 w-3.5" /> From link</TabsTrigger>
          </TabsList>

          <TabsContent value="upload" className="mt-0">
            <div
              onDragOver={e => { e.preventDefault(); setDragActive(true); }}
              onDragLeave={e => { e.preventDefault(); setDragActive(false); }}
              onDrop={onDrop}
              onClick={() => inputRef.current?.click()}
              className={cn(
                'flex cursor-pointer flex-col items-center justify-center rounded-lg border-2 border-dashed px-6 py-12 text-center transition-colors',
                dragActive ? 'border-accent bg-accent-subtle' : 'border-border-strong bg-surface-subtle hover:bg-surface-hover',
              )}
            >
              <input
                ref={inputRef}
                type="file"
                accept={ALLOWED_EXTS.join(',')}
                className="hidden"
                onChange={e => e.target.files?.[0] && validateAndSetFile(e.target.files[0])}
              />
              <Upload className="mb-2 h-6 w-6 text-ink-subtle" />
              {file ? (
                <div className="text-sm">
                  <span className="font-medium text-ink">{file.name}</span>
                  <span className="ml-2 text-ink-muted">{formatBytes(file.size)}</span>
                </div>
              ) : (
                <>
                  <p className="text-sm font-medium text-ink">Drop a video here, or click to browse</p>
                  <p className="mt-1 text-2xs text-ink-subtle">MP4, MOV, MKV, WEBM · up to 1 GB</p>
                </>
              )}
            </div>
          </TabsContent>

          <TabsContent value="url" className="mt-0">
            <div className="rounded-lg border border-border bg-surface-subtle p-4">
              <Label htmlFor="url-input">Video URL</Label>
              <Input
                id="url-input"
                placeholder="https://www.youtube.com/watch?v=..."
                value={url}
                onChange={e => setUrl(e.target.value)}
                className="mt-1.5"
              />
              <p className="mt-2 text-2xs text-ink-subtle">
                Supports YouTube, Vimeo, and many others via yt-dlp. The host server must have yt-dlp installed.
              </p>
            </div>
          </TabsContent>
        </Tabs>

        <SettingsPanel
          smoothing={smoothing} setSmoothing={setSmoothing}
          hands={hands} setHands={setHands}
          fps={fps} setFps={setFps}
          format={format} setFormat={setFormat}
          minVisibility={minVisibility} setMinVisibility={setMinVisibility}
          groundLockFeet={groundLockFeet} setGroundLockFeet={setGroundLockFeet}
          multipose={multipose} setMultipose={setMultipose}
        />

        {error && (
          <div className="mt-4 flex items-start gap-2 rounded-md border border-danger/20 bg-danger/5 p-3 text-sm text-danger">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
            <span>{error}</span>
          </div>
        )}

        <div className="mt-6 flex justify-end">
          <Button
            onClick={url.trim() ? submitUrl : submitUpload}
            disabled={submitting || (!file && !url.trim())}
            size="lg"
          >
            {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Film className="h-4 w-4" />}
            {submitting
              ? uploadProgress != null ? `Uploading ${Math.round(uploadProgress * 100)}%` : 'Starting…'
              : 'Start capture'}
          </Button>
        </div>
      </div>
    </WorkspaceShell>
  );
}

function SettingsPanel(props: {
  smoothing: number; setSmoothing: (n: number) => void;
  hands: boolean; setHands: (b: boolean) => void;
  fps: string; setFps: (s: string) => void;
  format: 'bvh' | 'fbx'; setFormat: (f: 'bvh' | 'fbx') => void;
  minVisibility: string; setMinVisibility: (s: string) => void;
  groundLockFeet: boolean; setGroundLockFeet: (b: boolean) => void;
  multipose: boolean; setMultipose: (b: boolean) => void;
}) {
  return (
    <div className="mt-4 rounded-lg border border-border bg-surface p-4">
      <h3 className="mb-3 text-sm font-semibold">Pipeline settings</h3>
      <div className="grid grid-cols-3 gap-4">
        <div>
          <Label htmlFor="smoothing">Smoothing (0–1)</Label>
          <Input
            id="smoothing"
            type="number" min={0} max={1} step={0.1}
            value={props.smoothing}
            onChange={e => props.setSmoothing(Number(e.target.value))}
            className="mt-1.5"
          />
        </div>
        <div>
          <Label htmlFor="fps">Frame rate (optional)</Label>
          <Input
            id="fps"
            type="number" min={1} max={240} placeholder="source"
            value={props.fps}
            onChange={e => props.setFps(e.target.value)}
            className="mt-1.5"
          />
        </div>
        <div>
          <Label htmlFor="format">Output format</Label>
          <Select value={props.format} onValueChange={(v) => props.setFormat(v as 'bvh' | 'fbx')}>
            <SelectTrigger id="format" className="mt-1.5"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="bvh">BVH</SelectItem>
              <SelectItem value="fbx">FBX (ASCII)</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>
      <details className="mt-3">
        <summary className="cursor-pointer text-2xs font-medium uppercase tracking-wide text-ink-muted">Advanced IK</summary>
        <div className="mt-2 grid grid-cols-2 gap-4">
          <div>
            <Label htmlFor="minvis">Min keypoint visibility (0–1)</Label>
            <Input
              id="minvis"
              type="number" min={0} max={1} step={0.05}
              value={props.minVisibility}
              onChange={e => props.setMinVisibility(e.target.value)}
              className="mt-1.5"
            />
          </div>
          <div className="flex flex-col gap-2 pt-5">
            <label className="flex items-center gap-2 text-sm text-ink-muted">
              <input type="checkbox" checked={props.groundLockFeet} onChange={e => props.setGroundLockFeet(e.target.checked)} className="h-4 w-4 rounded border-border" />
              Foot ground-locking (anti-skate)
            </label>
            <label className="flex items-center gap-2 text-sm text-ink-muted">
              <input type="checkbox" checked={props.multipose} onChange={e => props.setMultipose(e.target.checked)} className="h-4 w-4 rounded border-border" />
              Multi-person tracking (one BVH per person)
            </label>
          </div>
        </div>
      </details>
      <label className="mt-3 flex items-center gap-2 text-sm text-ink-muted">
        <input
          type="checkbox"
          checked={props.hands}
          onChange={e => props.setHands(e.target.checked)}
          className="h-4 w-4 rounded border-border"
        />
        Attempt hand tracking (ignored by MoveNet; reserved for future backends)
      </label>
    </div>
  );
}
