# mocap-ts

**Video → BVH motion capture, in pure TypeScript.**

Drop in a video (or a YouTube URL), get out a `.bvh` file you can drag into Blender, Maya, MotionBuilder, or any DCC tool that understands BVH. No Python, no C++ build chain, no fragile native pipeline — just Node 20+ and ffmpeg.

[![CI](https://github.com/ellyseum/mocap_ts/actions/workflows/ci.yml/badge.svg)](https://github.com/ellyseum/mocap_ts/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.7-3178c6.svg?logo=typescript&logoColor=white)](https://www.typescriptlang.org)
[![Tests](https://img.shields.io/badge/tests-88%20passing-success.svg)](./test)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](#contributing)

---

## Why

Most open-source mocap pipelines (FrankMocap, VIBE, EasyMocap) carry heavy ML stacks, restrictive research licenses, or both. `mocap-ts` is built around three constraints:

1. **MIT-licensed end to end** — safe to use commercially.
2. **No native build step** — `pnpm install`, that's it. The only runtime deps are TensorFlow.js Node and a pose-detection model.
3. **Single language** — the entire pipeline (decode → estimate → smooth → IK → export) is TypeScript. The Python script in this repo is *only* for previewing output in Blender; it is not part of the pipeline.

## Pipeline

```
                ┌────────────┐    ┌────────────┐    ┌──────────┐    ┌──────────┐    ┌────────┐    ┌──────┐
  video / url → │ ffmpeg     │ →  │ pose       │ →  │ temporal │ →  │ skeleton │ →  │ IK     │ →  │ BVH  │
                │ (frames)   │    │ estimator  │    │ smoother │    │ calibrate│    │ solver │    │ writer
                └────────────┘    └────────────┘    └──────────┘    └──────────┘    └────────┘    └──────┘
```

| Stage | Module | What it does |
|---|---|---|
| Decode | `src/video/decoder.ts` | Calls ffmpeg to extract frames; supports local files, frame dirs, and URLs (yt-dlp) |
| Estimate | `src/pose/estimator.ts` | TF.js pose-detection (BlazePose / MoveNet style); 33-keypoint body + optional hands |
| Smooth | `src/pose/smoother.ts` | EMA smoother to suppress per-frame jitter |
| Calibrate | `src/skeleton/calibrate.ts` | Measures the subject's bone lengths and builds a calibrated skeleton |
| IK | `src/skeleton/ik.ts` | Solves per-frame local rotations from world keypoints with quaternion continuity |
| Export | `src/export/bvh.ts` | Writes a standards-compliant BVH file |

## Install

```bash
# Requires: Node ≥20, ffmpeg, (optional) yt-dlp for URL inputs
pnpm install
pnpm run build          # builds core + web
```

Run the web app (starts Next.js + the mocap worker):

```bash
pnpm dev                # → http://localhost:3000
```

Or use the core as a library/CLI only:

```bash
pnpm --filter @mocap-ts/core build
node packages/core/dist/cli.js --input video.mp4 --output dance.bvh
```

> **System dependencies**
> - **ffmpeg** — `apt install ffmpeg` / `brew install ffmpeg`
> - **yt-dlp** (optional, for URL inputs) — `pip install yt-dlp` / `brew install yt-dlp`

## Usage

### CLI

```bash
mocap-ts --input video.mp4 --output dance.bvh
mocap-ts -i ./frames/                       # frame directory
mocap-ts -i https://www.youtube.com/watch?v=dQw4w9WgXcQ
mocap-ts -i video.mp4 --fps 30 --no-hands --smoothing 0.5 -v
```

| Flag | Default | Description |
|---|---|---|
| `-i, --input <path\|url>` | *required* | Video file, frame directory, or URL |
| `-o, --output <path>` | `<input>.bvh` | Destination BVH file |
| `-f, --fps <number>` | source fps | Frame extraction rate (1–240) |
| `--hands` / `--no-hands` | `--hands` | Include hand tracking |
| `-s, --smoothing <0-1>` | `0.7` | EMA smoothing alpha (0 = none, 1 = max) |
| `-v, --verbose` | off | Per-stage progress output |

### Programmatic

```ts
import { runPipeline } from 'mocap-ts';

await runPipeline({
  input: 'dance.mp4',
  output: 'dance.bvh',
  hands: true,
  smoothing: 0.7,
  verbose: false,
});
```

### Web app — Mocap Studio

A Notion-style motion workspace (`apps/web`) drives the core as a service:
upload a video or paste a link, watch per-stage progress, then download the
BVH or preview it in 3D with a swappable character + background.

```bash
# from repo root — starts the web app + the background mocap worker
pnpm dev
# → http://localhost:3000
```

System deps for the worker are the same as the CLI (ffmpeg, optional yt-dlp).
Job data lives under `MOCAP_DATA_DIR` (default `.mocap/`); override it for
containers / persistent volumes via `apps/web/.env.example`.

**Architecture in brief.** Submitting creates a `Job`; a single worker loop
(booted once via `instrumentation.ts`) claims queued jobs and runs the
streaming pipeline, emitting `JobProgress` events the UI receives over SSE.
The queue is a JSON-on-disk `FileJobQueue` by default — swap it for Inngest /
BullMQ / Redis later by implementing the `JobQueue` interface in `packages/core`.

### Preview in Blender

A helper Python script ships with the repo for visual QA — it imports a BVH and rigs a stick-figure mesh deformed by the armature.

```bash
blender --python render_bvh.py -- dance.bvh
```

## Development

```bash
pnpm run build       # tsc
pnpm test            # vitest run (88 tests)
pnpm run test:watch  # vitest watch mode
```

### Project layout

This is a **pnpm workspace** monorepo: a pure-TypeScript mocap core plus a
Notion-style web frontend that drives it.

```
├── packages/
│   ├── core/                       # @mocap-ts/core — the mocap pipeline library
│   │   ├── src/
│   │   │   ├── cli.ts              # argv parsing + entry point
│   │   │   ├── pipeline.ts         # end-to-end orchestration (CLI path)
│   │   │   ├── jobs/              # job queue + worker (web backend)
│   │   │   │   ├── queue.ts        # FileJobQueue (claim/ack, atomic writes)
│   │   │   │   ├── store.ts        # TF-free process singleton (for API routes)
│   │   │   │   ├── runner.ts       # streaming pipeline + worker loop
│   │   │   │   └── types.ts        # Job/Stage/Progress contracts
│   │   │   ├── video/decoder.ts    # ffmpeg + yt-dlp wrappers
│   │   │   ├── pose/               # TF.js MoveNet estimator + smoother + types
│   │   │   ├── skeleton/           # hierarchy, calibrate, mapping, ik
│   │   │   ├── math/               # vector3, matrix, quaternion primitives
│   │   │   └── export/bvh.ts       # BVH writer
│   │   └── test/                   # 96 tests, ~1:1 with src
│   └── tailwind-config/            # @mocap-ts/tailwind-config — shared Notion tokens
├── apps/
│   └── web/                        # @mocap-ts/web — Next.js 15 motion workspace
│       ├── src/
│       │   ├── app/                # App Router pages + API routes
│       │   │   ├── api/jobs/        # submit (upload/URL), status, SSE events, download
│       │   │   ├── jobs/[id]/       # job detail: timeline + progress + download + 3D
│       │   │   ├── new/            # upload / paste-a-link capture
│       │   │   └── viewer/          # standalone BVH viewer
│       │   ├── components/         # UI primitives (shadcn-style) + workspace + viewer
│       │   ├── lib/                # bvh-parser, use-job hook, stage helpers, types
│       │   └── server/             # TF-free queue access + worker bootstrap
│       └── instrumentation.ts      # starts the mocap worker at server boot
├── render_bvh.py                   # Blender preview script (not part of pipeline)
└── pnpm-workspace.yaml
```

**Why the split.** The core stays a clean, framework-free library (importable
by the CLI, future CLIs, or any other host). The web app is a thin client over
a job queue: uploads/URLs become jobs, a single background worker runs the
pipeline with per-stage progress, and the UI streams that progress over SSE.
The TF.js native stack is isolated to the worker entrypoint via a TF-free
`jobs/queue` subpath, so route handlers never bundle it.

### Testing philosophy

Math and pure-function modules (`vector3`, `quaternion`, `smoother`, `bvh`, `mapping`) have unit tests against analytic ground truth. `pipeline.test.ts` exercises the orchestration layer with a stub estimator. CI runs the full suite on Node 20 and 22.

## Roadmap

- [x] Notion-style web workspace (upload / URL → progress → BVH download)
- [x] In-browser 3D BVH viewer with swappable character + scene
- [x] Job queue abstraction (self-hostable `FileJobQueue`; swappable for Inngest/BullMQ)
- [x] FBX export (ASCII 7700, format toggle in the UI)
- [x] Multi-person tracking (MoveNet MultiPose → one BVH per person)
- [x] Confidence-weighted IK (configurable `minVisibility` threshold)
- [x] Foot contact detection + ground-locking (anti-skate)
- [x] WebGPU backend option for the estimator
- [x] glTF character import (drop .glb in `apps/web/public/assets/characters/`)
- [x] Exact ZXY-intrinsic BVH retargeting (mirrors the core writer)
- [x] Inngest JobQueue adapter (env-gated `MOCAP_QUEUE=inngest`)
- [ ] Multi-host worker (Redis-backed queue + N worker processes)
- [ ] FBX skinning/deformer (currently skeleton-only FBX)
- [ ] In-browser capture (camera → pose estimation via WebGPU)

## Contributing

PRs welcome. Please:

1. Open an issue first for non-trivial changes.
2. Run `pnpm test` and `pnpm run build` before submitting.
3. Add tests for new behavior — the coverage bar is roughly 1:1 with source LOC.

## License

[MIT](./LICENSE) © 2026 Jocelyn Ellyse
