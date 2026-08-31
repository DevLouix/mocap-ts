'use client';

import { useState, useRef } from 'react';
import { WorkspaceShell } from '@/components/layout/workspace-shell';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { BvhViewer } from '@/components/viewer/bvh-viewer';
import { Box, Upload } from 'lucide-react';

/**
 * Standalone BVH viewer. Two entry points:
 *   - paste a job id from a completed capture
 *   - drop a .bvh file from disk (for files produced elsewhere)
 *
 * The viewer component is reused from the job detail page so the
 * character/background swap UX is identical.
 */
export default function ViewerPage() {
  const [jobId, setJobId] = useState('');
  const [activeJobId, setActiveJobId] = useState<string | null>(null);
  const [pasteText, setPasteText] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const loadJob = () => {
    setPasteText(null);
    setActiveJobId(jobId.trim() || null);
  };

  const loadFile = async (file: File) => {
    const text = await file.text();
    setPasteText(text);
    setActiveJobId(null);
  };

  return (
    <WorkspaceShell active="viewer">
      <div className="mx-auto w-full max-w-4xl px-8 py-10">
        <header className="mb-6">
          <h1 className="text-2xl font-bold tracking-tight">BVH viewer</h1>
          <p className="mt-1 text-sm text-ink-muted">
            Preview a BVH in 3D. Apply it to a character, swap the background, scrub the timeline.
          </p>
        </header>

        <Card className="mb-4">
          <CardHeader>
            <CardTitle>Open a motion</CardTitle>
            <CardDescription>From a completed capture in this workspace, or a .bvh file on disk.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex items-end gap-2">
              <div className="flex-1">
                <Label htmlFor="jobid">Job ID</Label>
                <Input
                  id="jobid"
                  placeholder="e.g. 7a3f..."
                  value={jobId}
                  onChange={e => setJobId(e.target.value)}
                  className="mt-1.5"
                />
              </div>
              <Button onClick={loadJob} disabled={!jobId.trim()}>Load job</Button>
            </div>

            <div className="flex items-center gap-2">
              <div className="flex-1 border-t border-dashed border-border" />
              <span className="text-2xs text-ink-subtle">or</span>
              <div className="flex-1 border-t border-dashed border-border" />
            </div>

            <div>
              <input
                ref={fileRef}
                type="file"
                accept=".bvh,text/plain"
                className="hidden"
                onChange={e => e.target.files?.[0] && loadFile(e.target.files[0])}
              />
              <Button variant="outline" onClick={() => fileRef.current?.click()}>
                <Upload className="h-4 w-4" /> Drop a .bvh file
              </Button>
            </div>
          </CardContent>
        </Card>

        {activeJobId ? (
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2"><Box className="h-4 w-4" /> Preview</CardTitle>
            </CardHeader>
            <CardContent>
              <BvhViewer jobId={activeJobId} />
            </CardContent>
          </Card>
        ) : pasteText != null ? (
          <Card>
            <CardHeader><CardTitle>Pasted BVH preview</CardTitle></CardHeader>
            <CardContent>
              <FileBvhViewer text={pasteText} />
            </CardContent>
          </Card>
        ) : null}
      </div>
    </WorkspaceShell>
  );
}

/** A thin wrapper that parses a pasted BVH string instead of fetching it. */
function FileBvhViewer({ text }: { text: string }) {
  // The full 3D viewer is wired to the job download endpoint, so for pasted
  // text we render a note + a sanitized code preview. A shared inner viewer
  // component can lift this limitation later.
  return (
    <div className="rounded-md border border-border bg-surface-subtle p-4">
      <p className="text-sm text-ink-muted">
        Pasted BVH loaded ({text.length.toLocaleString()} chars). To view it in 3D, submit it as a
        capture via the API and open the resulting job. The 3D viewer is wired to the job download endpoint.
      </p>
      <pre className="mt-3 max-h-40 overflow-auto rounded bg-surface-muted p-2 text-2xs">
        {text.slice(0, 400)}
        {text.length > 400 ? '...' : ''}
      </pre>
    </div>
  );
}
