import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js';
import { KTX2Loader } from 'three/examples/jsm/loaders/KTX2Loader.js';

/**
 * Character + scene (background) presets for the BVH viewer.
 *
 * Characters come in two families:
 *   1. Procedural — built in code, joint hierarchy mirrors the BVH joint
 *      names so @/lib/bvh-retarget's `applyToLocalHierarchy` can set local
 *      quaternions directly.
 *   2. glTF — loaded from /public/assets/characters/*.glb (or .gltf). The
 *      viewer maps BVH joint names to the rig's bones by alias and writes
 *      local quaternions + root translation to the skeleton.
 *
 * To add a built-in character: append a preset whose `build` returns a
 * `CharacterInstance` whose `root` object3D graph mirrors BVH joint names.
 * To add a glTF character: drop a .glb in apps/web/public/assets/characters/.
 */

export interface CharacterInstance {
  root: THREE.Group;
  /** For glTF rigs, the skinned mesh's skeleton (undefined for procedural). */
  skeleton?: THREE.Skeleton;
  /** Optional BVH-name → bone-name map (built once per rig). */
  nameMap?: Map<string, string>;
}

export interface CharacterPreset {
  id: string;
  label: string;
  description: string;
  build: () => CharacterInstance;
}

/** The 20 joint names produced by the core skeleton, in hierarchy order. */
export const JOINT_NAMES = [
  'Hips', 'Spine', 'Spine1', 'Spine2', 'Neck', 'Head',
  'LeftShoulder', 'LeftArm', 'LeftForeArm', 'LeftHand',
  'RightShoulder', 'RightArm', 'RightForeArm', 'RightHand',
  'LeftUpLeg', 'LeftLeg', 'LeftFoot',
  'RightUpLeg', 'RightLeg', 'RightFoot',
] as const;

/** T-pose offsets matching packages/core/src/skeleton/hierarchy.ts. */
const REST_OFFSETS: Record<string, [number, number, number]> = {
  Hips: [0, 0, 0],
  Spine: [0, 10, 0], Spine1: [0, 10, 0], Spine2: [0, 10, 0],
  Neck: [0, 5, 0], Head: [0, 10, 0],
  LeftShoulder: [5, 2, 0], LeftArm: [10, 0, 0], LeftForeArm: [25, 0, 0], LeftHand: [25, 0, 0],
  RightShoulder: [-5, 2, 0], RightArm: [-10, 0, 0], RightForeArm: [-25, 0, 0], RightHand: [-25, 0, 0],
  LeftUpLeg: [10, -5, 0], LeftLeg: [0, -45, 0], LeftFoot: [0, -45, 0],
  RightUpLeg: [-10, -5, 0], RightLeg: [0, -45, 0], RightFoot: [0, -45, 0],
};

/** Parent links mirroring the core skeleton hierarchy. */
const PARENT_OF: Record<string, string | undefined> = {
  Hips: undefined, Spine: 'Hips', Spine1: 'Spine', Spine2: 'Spine1',
  Neck: 'Spine2', Head: 'Neck',
  LeftShoulder: 'Spine2', LeftArm: 'LeftShoulder', LeftForeArm: 'LeftArm', LeftHand: 'LeftForeArm',
  RightShoulder: 'Spine2', RightArm: 'RightShoulder', RightForeArm: 'RightArm', RightHand: 'RightForeArm',
  LeftUpLeg: 'Hips', LeftLeg: 'LeftUpLeg', LeftFoot: 'LeftLeg',
  RightUpLeg: 'Hips', RightLeg: 'RightUpLeg', RightFoot: 'RightLeg',
};

/** Lift the whole figure so feet rest near y=0 (sum of leg offsets ≈ 95). */
const ROOT_LIFT_Y = 95;

/** Common builder that wires a THREE.Object3D hierarchy by joint name. */
function buildHierarchy(makeJoint: (name: string) => THREE.Object3D | null): CharacterInstance {
  const root = new THREE.Group();
  const byName = new Map<string, THREE.Object3D>();
  for (const name of JOINT_NAMES) {
    const obj = makeJoint(name);
    if (!obj) continue;
    obj.name = name;
    byName.set(name, obj);
  }
  // Parent each joint under its skeleton parent.
  for (const [name, obj] of byName) {
    const parentName = PARENT_OF[name];
    const parent = parentName ? byName.get(parentName) : null;
    (parent ?? root).add(obj);
    const off = REST_OFFSETS[name];
    if (off) obj.position.set(off[0], off[1], off[2]);
  }
  root.position.set(0, ROOT_LIFT_Y, 0);
  return { root };
}

/** "Stick" character: a sphere per joint + thin bones drawn between them. */
function buildStickFigure(): CharacterInstance {
  const sphereGeo = new THREE.SphereGeometry(1.4, 12, 8);
  const jointMat = new THREE.MeshStandardMaterial({ color: 0x2383e2, roughness: 0.4 });
  const instance = buildHierarchy(name => new THREE.Mesh(sphereGeo, jointMat));
  // Bone cylinders are represented by thin lines drawn from each joint to
  // its children in the viewer's update loop — but to keep this builder
  // self-contained we add Line segments here from rest offsets.
  const boneMat = new THREE.LineBasicMaterial({ color: 0x37352f });
  for (const [name, parentName] of Object.entries(PARENT_OF)) {
    if (!parentName) continue;
    const a = instance.root.getObjectByName(parentName);
    const b = instance.root.getObjectByName(name);
    if (!a || !b) continue;
    const geo = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(REST_OFFSETS[parentName][0], REST_OFFSETS[parentName][1], REST_OFFSETS[parentName][2]),
      new THREE.Vector3(REST_OFFSETS[parentName][0] + REST_OFFSETS[name][0], REST_OFFSETS[parentName][1] + REST_OFFSETS[name][1], REST_OFFSETS[parentName][2] + REST_OFFSETS[name][2]),
    ]);
    const line = new THREE.Line(geo, boneMat);
    a.add(line);
  }
  return instance;
}

/** "Blocky" humanoid: low-poly boxes for limbs + head. */
function buildBlockyFigure(): CharacterInstance {
  const skin = new THREE.MeshStandardMaterial({ color: 0xe8c9a0, roughness: 0.7 });
  const cloth = new THREE.MeshStandardMaterial({ color: 0x3b4252, roughness: 0.8 });
  const box = (w: number, h: number, d: number, mat: THREE.Material, yOffset: number) => {
    const geo = new THREE.BoxGeometry(w, h, d) as THREE.BufferGeometry & { parameters: { height: number } };
    const m = new THREE.Mesh(geo, mat);
    m.position.y = yOffset;
    return m;
  };
  const instance = buildHierarchy(name => {
    const pivot = new THREE.Group();
    // Attach a limb mesh so it hangs downward from the joint.
    switch (name) {
      case 'Head': pivot.add(box(9, 10, 9, skin, -5)); break;
      case 'Spine2': pivot.add(box(16, 30, 9, cloth, -15)); break; // torso
      case 'LeftArm':
      case 'RightArm': pivot.add(box(4, 25, 4, skin, -12.5)); break;
      case 'LeftForeArm':
      case 'RightForeArm': pivot.add(box(3.5, 25, 3.5, skin, -12.5)); break;
      case 'LeftHand':
      case 'RightHand': pivot.add(box(4, 8, 3, skin, -4)); break;
      case 'LeftUpLeg':
      case 'RightUpLeg': pivot.add(box(5, 45, 5, cloth, -22.5)); break;
      case 'LeftLeg':
      case 'RightLeg': pivot.add(box(4.5, 45, 4.5, cloth, -22.5)); break;
      case 'LeftFoot':
      case 'RightFoot': pivot.add(box(7, 4, 14, skin, -2)); pivot.children[0].position.set(0, -2, 4); break;
    }
    return pivot;
  });
  return instance;
}

export const CHARACTER_PRESETS: CharacterPreset[] = [
  { id: 'stick', label: 'Stick figure', description: 'Bones + joint spheres. Fastest, always reliable.', build: buildStickFigure },
  { id: 'blocky', label: 'Blocky humanoid', description: 'Low-poly box character. Reads as a person at a glance.', build: buildBlockyFigure },
];

/** Build a procedural character from a preset (mirrors the old build()). */
export function buildProceduralCharacter(preset: CharacterPreset): CharacterInstance {
  return preset.build();
}

// --- glTF loading ---

let gltfLoader: GLTFLoader | null = null;

/** Lazily create a GLTFLoader with DRACO + KTX2 support. */
function getGltfLoader(): GLTFLoader {
  if (gltfLoader) return gltfLoader;
  const loader = new GLTFLoader();
  // DRACO decoder served from a CDN so we ship no wasm binary ourselves.
  const draco = new DRACOLoader();
  draco.setDecoderPath('https://www.gstatic.com/draco/versionedencoders/1.5.7/');
  loader.setDRACOLoader(draco);
  // KTX2 for compressed textures — uses a WebWorker.
  try {
    const ktx2 = new KTX2Loader();
    ktx2.setTranscoderPath('https://www.gstatic.com/three/basis/');
    loader.setKTX2Loader(ktx2);
  } catch {
    // KTX2 optional — skip if unavailable.
  }
  gltfLoader = loader;
  return loader;
}

/** Cached manifest of glTF characters discovered under /assets/characters. */
let assetCache: { id: string; label: string }[] | null = null;
// (typed as possibly-null internally; the public API returns a non-null array)

/**
 * List glTF characters available under /public/assets/characters.
 *
 * We fetch a JSON manifest generated at build time (see the API route
 * /api/assets/characters). If the manifest is missing, fall back to a small
 * hardcoded list so the UI degrades gracefully.
 */
export async function listAssetCharacters(): Promise<{ id: string; label: string }[]> {
  if (assetCache) return assetCache.slice();
  try {
    const r = await fetch('/api/assets/characters');
    if (r.ok) {
      const data = (await r.json()) as { id: string; label: string }[];
      assetCache = Array.isArray(data) ? data : [];
      return assetCache.slice();
    }
  } catch { /* fall through */ }
  assetCache = [];
  return assetCache.slice();
}

/** Invalidate the asset cache (after uploading a new character). */
export function invalidateAssetCache(): void {
  assetCache = null;
}

/**
 * Load a glTF character from /assets/characters/<assetId> and return a
 * CharacterInstance wrapping the skinned mesh + skeleton.
 */
export async function loadGltfCharacter(assetId: string, scene: THREE.Scene): Promise<CharacterInstance> {
  // The manifest entry's id is the filename without extension; resolve to a URL.
  const url = `/assets/characters/${assetId}`;
  const loader = getGltfLoader();
  const gltf = await loader.loadAsync(url);

  const root = new THREE.Group();
  // Center the rig so feet rest near y=0.
  const bbox = new THREE.Box3().setFromObject(gltf.scene);
  const size = new THREE.Vector3();
  bbox.getSize(size);
  // Scale to roughly our BVH-world units (BVH hips at ~95cm).
  const scale = size.y > 0 ? Math.min(2, 170 / size.y) : 1;
  gltf.scene.scale.setScalar(scale);
  root.add(gltf.scene);

  // Recenter feet to y=0.
  const bbox2 = new THREE.Box3().setFromObject(root);
  root.position.y -= bbox2.min.y;

  // Find the first skinned mesh + its skeleton.
  let skeleton: THREE.Skeleton | undefined;
  root.traverse(o => {
    const skinned = o as THREE.SkinnedMesh;
    if (!skeleton && skinned.isSkinnedMesh && skinned.skeleton) {
      skeleton = skinned.skeleton;
    }
  });
  if (skeleton) {
    // Force a bind so rest pose is correct.
    skeleton.calculateInverses();
  }
  return { root, skeleton };
}

// --- scene (background) presets ---

export interface BackgroundPreset {
  id: string;
  label: string;
  apply: (scene: THREE.Scene) => void;
}

export const BACKGROUND_PRESETS: BackgroundPreset[] = [
  {
    id: 'studio',
    label: 'Studio',
    apply: (scene) => {
      scene.background = new THREE.Color(0xf7f6f3);
      scene.fog = null;
    },
  },
  {
    id: 'dark',
    label: 'Dark stage',
    apply: (scene) => {
      scene.background = new THREE.Color(0x1f1d1a);
      scene.fog = new THREE.Fog(0x1f1d1a, 120, 400);
    },
  },
  {
    id: 'grid',
    label: 'Grid floor',
    apply: (scene) => {
      scene.background = new THREE.Color(0xe9e8e3);
      scene.fog = null;
      // A grid helper is added by the viewer; this just sets the color.
    },
  },
  {
    id: 'warm',
    label: 'Warm floor',
    apply: (scene) => {
      scene.background = new THREE.Color(0xf2ece4);
      scene.fog = null;
    },
  },
  {
    id: 'void',
    label: 'Void',
    apply: (scene) => {
      scene.background = new THREE.Color(0x0d0c0a);
      scene.fog = new THREE.Fog(0x0d0c0a, 80, 300);
    },
  },
];
