import 'server-only';
import { NextResponse } from 'next/server';
import { readdirSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

/**
 * GET /api/assets/characters — list glTF characters available to the viewer.
 *
 * Scans the web app's `public/assets/characters/` directory for .glb/.gltf
 * files and returns a manifest the viewer consumes:
 *
 *   [{ id: 'roboto.glb', label: 'roboto', url: '/assets/characters/roboto.glb' }]
 *
 * Adding a character is purely a filesystem operation — drop a .glb in the
 * dir and it appears. No restart, no manifest file to maintain.
 *
 * For a deploy where public/ is read-only, mount a writable volume here and
 * add an upload route that writes into it (future work).
 */
export async function GET() {
  const dir = join(process.cwd(), 'public', 'assets', 'characters');
  if (!existsSync(dir)) return NextResponse.json([]);

  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return NextResponse.json([]);
  }

  const out: { id: string; label: string }[] = [];
  for (const f of entries) {
    const lower = f.toLowerCase();
    if (!lower.endsWith('.glb') && !lower.endsWith('.gltf')) continue;
    const st = statSync(join(dir, f));
    if (!st.isFile()) continue;
    const label = f.replace(/\.(glb|gltf)$/i, '').replace(/[-_]+/g, ' ');
    out.push({ id: f, label });
  }
  return NextResponse.json(out);
}
