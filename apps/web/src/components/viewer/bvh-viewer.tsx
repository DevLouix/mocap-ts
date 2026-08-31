'use client';

import { useEffect, useRef, useState, useCallback } from 'react';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js';
import { KTX2Loader } from 'three/examples/jsm/loaders/KTX2Loader.js';
import { Button } from '@/components/ui/button';
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '@/components/ui/select';
import { Label } from '@/components/ui/label';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { parseBVH, resolveFrame, type BvhData } from '@/lib/bvh-parser';
import { resolveFrameTransforms, applyToLocalHierarchy, applyToSkinnedMesh, buildNameMap } from '@/lib/bvh-retarget';
import {
  CHARACTER_PRESETS,
  BACKGROUND_PRESETS,
  type CharacterPreset,
  type CharacterInstance,
  type BackgroundPreset,
  buildProceduralCharacter,
  loadGltfCharacter,
  listAssetCharacters,
} from './characters';
import { Play, Pause, RotateCcw, RefreshCw } from 'lucide-react';

interface Props {
  jobId: string;
}

/** What kind of character is currently mounted. */
type MountedCharacter =
  | { kind: 'procedural'; preset: CharacterPreset; instance: CharacterInstance }
  | { kind: 'gltf'; assetId: string; instance: CharacterInstance };

/**
 * In-browser BVH viewer.
 *
 * - Fetches the BVH text for the job and parses it.
 * - Builds a Three.js scene with a grid floor, lights, and the selected
 *   character (a procedural preset OR a .glb/.gltf loaded from
 *   /public/assets/characters).
 * - Applies BVH motion frame-by-frame using the EXACT ZXY-intrinsic
 *   quaternion retargeting in @/lib/bvh-retarget (mirrors the core writer).
 *   For procedural characters, local quaternions are set per joint; for
 *   glTF rigs, world transforms are applied to the skeleton bones by name.
 * - Lets the user swap the character and the background (scene) at runtime.
 *
 * The BVH download itself is the source of truth — this viewer is a preview.
 */
export function BvhViewer({ jobId }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
  const sceneRef = useRef<THREE.Scene | null>(null);
  const characterRef = useRef<THREE.Group | null>(null);
  const mountedRef = useRef<MountedCharacter | null>(null);
  const bvhRef = useRef<BvhData | null>(null);
  const frameRef = useRef(0);
  const playingRef = useRef(true);

  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [error, setError] = useState<string | null>(null);
  const [frame, setFrame] = useState(0);
  const [totalFrames, setTotalFrames] = useState(0);
  const [playing, setPlaying] = useState(true);
  const [characterId, setCharacterId] = useState(CHARACTER_PRESETS[0].id);
  const [backgroundId, setBackgroundId] = useState(BACKGROUND_PRESETS[0].id);
  const [assetCharacters, setAssetCharacters] = useState<{ id: string; label: string }[]>([]);
  const [loadingCharacter, setLoadingCharacter] = useState(false);

  // Fetch + parse BVH on mount.
  useEffect(() => {
    let cancelled = false;
    fetch(`/api/jobs/${jobId}/download`)
      .then(r => {
        if (!r.ok) throw new Error('BVH not available');
        return r.text();
      })
      .then(text => {
        if (cancelled) return;
        bvhRef.current = parseBVH(text);
        setTotalFrames(bvhRef.current.frames.length);
        setStatus('ready');
      })
      .catch(e => {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : 'failed to load BVH');
        setStatus('error');
      });
    return () => { cancelled = true; };
  }, [jobId]);

  // Discover glTF characters from the assets directory.
  useEffect(() => {
    listAssetCharacters()
      .then(setAssetCharacters)
      .catch(() => setAssetCharacters([]));
  }, []);

  // (Re)build the Three.js scene when the container + BVH are ready.
  useEffect(() => {
    if (status !== 'ready' || !containerRef.current) return;
    const container = containerRef.current;

    const scene = new THREE.Scene();
    sceneRef.current = scene;

    const camera = new THREE.PerspectiveCamera(45, container.clientWidth / container.clientHeight, 0.1, 2000);
    camera.position.set(0, 90, 220);
    camera.lookAt(0, 90, 0);

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setSize(container.clientWidth, container.clientHeight);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    container.appendChild(renderer.domElement);
    rendererRef.current = renderer;

    // Lighting — soft 3-point.
    scene.add(new THREE.AmbientLight(0xffffff, 0.6));
    const key = new THREE.DirectionalLight(0xffffff, 0.8);
    key.position.set(50, 100, 80);
    scene.add(key);
    const fill = new THREE.DirectionalLight(0xffffff, 0.3);
    fill.position.set(-60, 40, -40);
    scene.add(fill);

    // Grid floor for spatial reference.
    const grid = new THREE.GridHelper(400, 40, 0xbebeba, 0xebebea);
    grid.position.y = 0;
    scene.add(grid);

    // Apply the initial background + character.
    applyBackground(BACKGROUND_PRESETS[0], scene);
    mountProcedural(CHARACTER_PRESETS[0], scene);

    // Animation loop.
    const clock = new THREE.Clock();
    let lastFrameTime = 0;
    const frameTime = bvhRef.current?.frameTime ?? 1 / 30;

    let raf = 0;
    const animate = () => {
      raf = requestAnimationFrame(animate);
      const dt = clock.getDelta();
      if (playingRef.current && bvhRef.current) {
        lastFrameTime += dt;
        if (lastFrameTime >= frameTime) {
          lastFrameTime = 0;
          frameRef.current = (frameRef.current + 1) % (bvhRef.current.frames.length || 1);
          setFrame(frameRef.current);
          applyCurrentFrame();
        }
      }
      renderer.render(scene, camera);
    };
    animate();

    // Apply the first frame immediately so the pose is visible when paused.
    if (bvhRef.current) applyCurrentFrame();

    const onResize = () => {
      if (!container) return;
      camera.aspect = container.clientWidth / container.clientHeight;
      camera.updateProjectionMatrix();
      renderer.setSize(container.clientWidth, container.clientHeight);
    };
    const ro = new ResizeObserver(onResize);
    ro.observe(container);

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      renderer.dispose();
      if (renderer.domElement.parentNode) {
        renderer.domElement.parentNode.removeChild(renderer.domElement);
      }
      sceneRef.current = null;
      rendererRef.current = null;
      characterRef.current = null;
      mountedRef.current = null;
    };
  }, [status]);

  // Sync playing state to the ref the animation loop reads.
  useEffect(() => { playingRef.current = playing; }, [playing]);

  // Apply the current frame to whatever character is mounted.
  const applyCurrentFrame = useCallback(() => {
    const bvh = bvhRef.current;
    const scene = sceneRef.current;
    const mounted = mountedRef.current;
    if (!bvh || !scene || !mounted) return;
    const frame = resolveFrame(bvh, frameRef.current);
    const transforms = resolveFrameTransforms(bvh, frame, 1);
    if (mounted.kind === 'procedural') {
      applyToLocalHierarchy(bvh, transforms, mounted.instance.root);
    } else {
      // glTF skinned mesh.
      const skeleton = mounted.instance.skeleton;
      if (skeleton) {
        const nameMap = mounted.instance.nameMap ?? buildNameMap(skeleton);
        applyToSkinnedMesh(bvh, transforms, skeleton, nameMap);
      }
    }
  }, []);

  // Swap character when preset changes (procedural presets only).
  useEffect(() => {
    if (status !== 'ready' || !sceneRef.current) return;
    // Only react to the procedural preset ids; glTF assets use a separate path.
    const preset = CHARACTER_PRESETS.find(p => p.id === characterId);
    if (!preset) return;
    mountProcedural(preset, sceneRef.current);
    applyCurrentFrame();
  }, [characterId, status, applyCurrentFrame]);

  // Swap background when preset changes.
  useEffect(() => {
    if (!sceneRef.current) return;
    const preset = BACKGROUND_PRESETS.find(p => p.id === backgroundId)!;
    applyBackground(preset, sceneRef.current);
  }, [backgroundId]);

  // Load a glTF character from the assets dir.
  const onSelectAsset = useCallback(async (assetId: string) => {
    if (!sceneRef.current) return;
    setLoadingCharacter(true);
    setError(null);
    try {
      const instance = await loadGltfCharacter(assetId, sceneRef.current);
      unmountCurrent();
      mountedRef.current = { kind: 'gltf', assetId, instance };
      characterRef.current = instance.root;
      // The characterId state is a unified value; set it to the asset id so
      // the Select reflects the choice (procedural presets won't match).
      setCharacterId(assetId);
      applyCurrentFrame();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'failed to load character');
    } finally {
      setLoadingCharacter(false);
    }
  }, [applyCurrentFrame]);

  const unmountCurrent = () => {
    const scene = sceneRef.current;
    if (scene && characterRef.current) {
      scene.remove(characterRef.current);
      disposeHierarchy(characterRef.current);
    }
    characterRef.current = null;
    mountedRef.current = null;
  };

  const mountProcedural = (preset: CharacterPreset, scene: THREE.Scene) => {
    unmountCurrent();
    const instance = buildProceduralCharacter(preset);
    scene.add(instance.root);
    characterRef.current = instance.root;
    mountedRef.current = { kind: 'procedural', preset, instance };
  };

  if (status === 'loading') {
    return <div className="flex h-80 items-center justify-center text-sm text-ink-muted">Loading 3D preview…</div>;
  }
  if (status === 'error') {
    return <div className="flex h-80 items-center justify-center text-sm text-danger">BVH preview unavailable: {error}</div>;
  }

  return (
    <TooltipProvider>
      <div ref={containerRef} className="h-96 w-full overflow-hidden rounded-md border border-border bg-surface-subtle" />

      <div className="mt-3 flex flex-wrap items-end justify-between gap-4">
        <div className="flex items-center gap-2">
          <Button size="icon" variant="outline" onClick={() => setPlaying(p => !p)}>
            {playing ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
          </Button>
          <Button size="icon" variant="outline" onClick={() => { frameRef.current = 0; setFrame(0); applyCurrentFrame(); }}>
            <RotateCcw className="h-4 w-4" />
          </Button>
          <span className="text-2xs tabular-nums text-ink-muted">
            frame {frame + 1} / {totalFrames || 0}
          </span>
        </div>

        <div className="flex gap-3">
          <div>
            <Label>Character</Label>
            <Select value={characterId} onValueChange={(id) => {
              const preset = CHARACTER_PRESETS.find(p => p.id === id);
              if (preset) setCharacterId(id);
              else onSelectAsset(id);
            }}>
              <SelectTrigger className="mt-1 w-44">
                {loadingCharacter ? <RefreshCw className="h-3.5 w-3.5 animate-spin" /> : <SelectValue />}
              </SelectTrigger>
              <SelectContent>
                <SelectGroup label="Built-in">
                  {CHARACTER_PRESETS.map(p => (
                    <SelectItem key={p.id} value={p.id}>{p.label}</SelectItem>
                  ))}
                </SelectGroup>
                {assetCharacters.length > 0 && (
                  <SelectGroup label="From assets">
                    {assetCharacters.map(c => (
                      <SelectItem key={c.id} value={c.id}>{c.label}</SelectItem>
                    ))}
                  </SelectGroup>
                )}
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label>Scene</Label>
            <Select value={backgroundId} onValueChange={setBackgroundId}>
              <SelectTrigger className="mt-1 w-36"><SelectValue /></SelectTrigger>
              <SelectContent>
                {BACKGROUND_PRESETS.map(p => (
                  <SelectItem key={p.id} value={p.id}>{p.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
      </div>

      {error && (
        <p className="mt-2 text-2xs text-danger">{error}</p>
      )}
      <p className="mt-1 text-2xs text-ink-subtle">
        Tip: drop .glb files in <code className="rounded bg-surface-muted px-1">apps/web/public/assets/characters/</code> to add characters. The viewer retargets by bone name (Hips, Spine, LeftArm, …).
      </p>
    </TooltipProvider>
  );
}

// --- SelectGroup shim (radix Select.Group isn't exported by our wrapper) ---
function SelectGroup({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="px-2 py-1 text-2xs font-medium uppercase tracking-wide text-ink-subtle">{label}</div>
      {children}
    </div>
  );
}

// --- scene helpers ---

function applyBackground(preset: BackgroundPreset, scene: THREE.Scene): void {
  preset.apply(scene);
}

function disposeHierarchy(obj: THREE.Object3D): void {
  obj.traverse(o => {
    const mesh = o as THREE.Mesh;
    if (mesh.geometry) mesh.geometry.dispose();
    const mat = mesh.material as THREE.Material | THREE.Material[] | undefined;
    if (Array.isArray(mat)) mat.forEach(m => m.dispose());
    else mat?.dispose();
  });
}
