# mocap-ts

**Motion-production workspace, in pure TypeScript.**

Turn video into reusable motion, apply it to your characters, compose scenes and timelines, create 3D videos, review versions, and export to Blender, Maya, Unreal, Unity, and other production tools. Video-to-BVH is the first processing capability inside the workspace, not the final product.

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
containers / persistent volumes. In file mode, the API stores uploads in
`<data-root>/uploads` and the worker validates that same root, so set one
shared absolute `MOCAP_DATA_DIR` when running processes from different
working directories. Remote URLs use an approved-host allowlist
and reject credentials, non-standard ports, and private/reserved DNS results.
Set `MOCAP_ALLOWED_URL_HOSTS=example.com,media.example` only for domains you
control and trust.

**Authentication modes.** Local development and the single-workspace Docker
profile use `MOCAP_AUTH_MODE=local`. Production should use
`MOCAP_AUTH_MODE=header` behind a trusted OIDC/SAML-aware reverse proxy, set
`MOCAP_AUTH_HEADER_SECRET`, and have that proxy strip client-supplied
`x-mocap-*` identity headers before adding verified claims. The application
scopes jobs and assets to the authenticated workspace; it does not treat a
UUID as authorization. In durable header-auth mode, the effective role is also
checked against the PostgreSQL workspace membership before each operation.

**Architecture in brief.** Submitting creates a `Job`; a single worker loop
(booted once via `instrumentation.ts`) claims queued jobs and runs the
streaming pipeline, emitting `JobProgress` events the UI receives over SSE.
The queue is a JSON-on-disk `FileJobQueue` by default for lightweight local
work. For the durable self-hosted deployment, set `MOCAP_PERSISTENCE=durable`:
job metadata is stored in PostgreSQL, media/artifacts in MinIO or any S3-
compatible service, and execution is dispatched through Redis/BullMQ to the
separate `apps/worker` process. The file queue is single-host infrastructure
only; it must not be used as shared production storage.

### Docker (self-hosting)

ffmpeg + yt-dlp + the TF native stack are baked into the image, so the whole
platform runs with no host installs:

```bash
pnpm platform:prod:start
# → http://localhost:3000
# MinIO console → http://localhost:9001
```

Platform lifecycle commands:

```bash
# Development: Next.js dev server + in-process file worker
pnpm platform:dev:start
pnpm platform:dev:status
pnpm platform:dev:logs
pnpm platform:dev:stop

# Production: durable Docker Compose stack
pnpm platform:prod:start       # builds and starts detached services
pnpm platform:prod:status
pnpm platform:prod:logs
pnpm platform:prod:stop        # stops services; preserves named volumes
pnpm platform:prod:restart
```

The equivalent generic form is `pnpm platform <dev|prod> <start|stop|restart|status|logs>`.
The development controller stores its PID and log under `.mocap/platform/`.
Production uses `docker compose stop` rather than removing containers or
volumes; data deletion must be performed deliberately with Docker commands.

For direct Docker usage, `docker compose up --build` remains supported.
```

The durable Compose profile persists PostgreSQL, Redis, and MinIO data in
named volumes. Uploads and motion artifacts are stored in MinIO; job metadata
is stored in PostgreSQL. The web service is the control plane and
`apps/worker` is the independent processing plane. Large browser uploads use
resumable S3 multipart sessions automatically; the server validates the final
object before it becomes a processing job. `S3_PUBLIC_ENDPOINT` must be a
browser-reachable S3 endpoint (the Compose default is `http://localhost:9000`).

Durable workers use fenced PostgreSQL leases with heartbeats. A reaper
re-queues expired attempts and terminally records exhausted attempts as dead
letters. Owners/admins can inspect them at `GET /api/ops/dead-letters` and
redrive one with `POST /api/ops/dead-letters/:id`; these endpoints require
header-auth mode with a matching PostgreSQL workspace membership in production.
Tune recovery with `MOCAP_LEASE_SECONDS` and `MOCAP_REAPER_INTERVAL_MS`.

**YouTube bot checks.** From datacenter/cloud IPs, YouTube often answers URL
downloads with *"Sign in to confirm you're not a bot"* — the app surfaces this
as an explicit error with instructions. The fix is cookies, not retries:
export `cookies.txt` (Netscape format) from a browser logged into YouTube and
uncomment the two cookie lines in `docker-compose.yml`, or set
`YTDLP_COOKIES_FILE=/path/to/cookies.txt` in any environment.

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

**Why the split.** The core stays a clean, framework-free library (importable by the CLI, future
workers, render services, or any other host). The web app is evolving into a
control plane for a project-based motion workspace. The current job queue is
for local development; the enterprise path moves metadata to PostgreSQL,
media to object storage, execution to durable queues and isolated workers, and
progress to a shared event stream. The product domain contracts live in
`@mocap-ts/core/workspace` so captures, motion takes, characters, scenes,
timelines, renders, exports, reviews, and versions do not become fields on one
catch-all job record.

See [`docs/platform-roadmap.md`](./docs/platform-roadmap.md) for the target
architecture, threat model, product workflows, and phased development plan.

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
- [x] Multi-host worker foundation (Redis/BullMQ + independent CPU worker process)
- [ ] FBX skinning/deformer (currently skeleton-only FBX)
- [ ] In-browser capture (camera → pose estimation via WebGPU)
- [x] Production workspace domain contracts (`@mocap-ts/core/workspace`)
- [x] PostgreSQL + object storage + durable worker plane foundation
- [ ] Non-destructive timeline editor and asynchronous 3D video rendering
- [ ] Organization security, review, versioning, APIs, and integrations
- [x] Phase 0 tenant boundary, URL policy, upload validation, retries, cancellation, and cleanup

## Contributing

PRs welcome. Please:

1. Open an issue first for non-trivial changes.
2. Run `pnpm test` and `pnpm run build` before submitting.
3. Add tests for new behavior — the coverage bar is roughly 1:1 with source LOC.

## License

[MIT](./LICENSE) © 2026 Jocelyn Ellyse
