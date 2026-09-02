# Motion Production Platform Roadmap

## Product Direction

mocap-ts is evolving from a video-to-BVH utility into a motion-production workspace.
Mocap is one input to the workspace. The product's core value is helping a team
turn footage into reusable motion, apply it to characters, compose scenes, make
3D videos, review versions, and export the result to production tools.

The primary workflow is:

```text
Organization
  -> Workspace
    -> Project
      -> Capture footage
        -> Process motion
          -> Review and clean
            -> Retarget to character
              -> Compose scene and timeline
                -> Render 3D video
                  -> Approve, version, export, share
```

## Product Surfaces

### 1. Capture and Processing

- Upload local footage through resumable uploads.
- Import remote video through a controlled downloader service.
- Normalize resolution, frame rate, orientation, and timecode.
- Detect capture quality before spending inference capacity.
- Select one or more performers.
- Choose a processing profile and model version.
- Produce a versioned motion take with confidence and warning metadata.

### 2. Motion Review and Editing

- View the source video and solved skeleton on a synchronized timeline.
- Scrub, trim, loop, mirror, retime, and blend clips.
- Pin feet and hands to contacts.
- Correct individual poses or keyframes.
- Mark occlusion and bad tracking ranges.
- Reprocess only selected ranges when possible.
- Compare takes and approve a version.

### 3. Character and Rig Library

- Upload GLB, glTF, FBX, and eventually USD characters.
- Validate skeleton, units, axes, root bone, rest pose, and required mappings.
- Store private project assets and organization-shared assets separately.
- Provide a visual bone mapping and rest-pose correction editor.
- Save retarget presets by character and motion profile.

### 4. Scene and 3D Video Workspace

- Select or import scene environments.
- Add multiple characters to a timeline.
- Apply one or more motion clips to each character track.
- Transform, mute, hide, loop, blend, and retime tracks.
- Configure cameras, lighting, background, and render settings.
- Preview interactively in WebGL.
- Render MP4, WebM, or image sequences asynchronously.
- Preserve the timeline as an editable, non-destructive asset.

### 5. Production Collaboration

- Organization, workspace, and project membership.
- Roles: owner, admin, editor, reviewer, viewer.
- Comments anchored to an entity and optional frame number.
- Review states: open, changes requested, approved, resolved.
- Immutable versions for motion takes, timelines, characters, scenes, and renders.
- Audit history for changes, downloads, approvals, and deletions.

## Target Architecture

```text
                    Control Plane
  Web UI -> API -> Auth/RBAC -> PostgreSQL -> Audit/Billing
                    |                  |
                    |                  +-- project metadata and versions
                    |
                    +--> Object storage: video, characters, motion, renders
                    |
                    +--> Queue: processing, retargeting, rendering
                                      |
                              Processing Plane
                 CPU media workers | GPU inference workers
                                      |
                normalize -> detect -> track -> solve -> clean
                                      |
                          retarget -> validate -> export/render
                                      |
                              Event stream -> UI/webhooks
```

### Boundaries

- **Web/API:** control plane only. It authenticates users, validates commands,
  creates records, issues upload/download URLs, and displays state.
- **PostgreSQL:** source of truth for tenant-owned metadata and state machines.
- **Object storage:** source footage, character files, motion data, previews,
  render outputs, and immutable snapshots. Store object keys, never signed URLs.
- **Queue:** leases, retries, priorities, concurrency limits, and dead-letter
  handling for processing work.
- **Workers:** isolated services for media, inference, retargeting, and render.
  They must not depend on a web process staying alive.
- **Core package:** framework-free motion algorithms and serialization contracts.
- **Editor/viewer:** a client application over versioned motion and timeline APIs.

## Data Model

The canonical relationship is:

```text
Organization
  Workspace
    Project
      Capture
        MotionTake
      CharacterAsset + RigDefinition
      Scene
      Timeline
        SceneTrack
        CharacterTrack
          MotionClip -> MotionTake
      RenderJob -> AssetRef
      MotionExport -> AssetRef
      ReviewComment
      VersionSnapshot
```

The initial provider-neutral contracts live in `@mocap-ts/core/workspace`.
They are intentionally not database models. The API and persistence layers can
map them to PostgreSQL without coupling the core package to an ORM.

## State Machines

### Capture

```text
created -> uploading -> ready -> processing -> complete
                         \-> failed
complete -> deleted
```

### Motion Take

```text
queued -> running -> review -> approved
             \-> failed
queued/running/review -> cancelled
```

### Render

```text
queued -> running -> complete
             \-> failed
queued/running -> cancelled
```

State transitions must be validated server-side. A client must never be able
to set an arbitrary state or modify a completed artifact in place.

## Development Phases

### Phase 0: Production correctness and threat reduction

Status: substantially implemented for the current single-host runtime. The
remaining limits are intentional and belong to Phase 1: multipart parsing is
still handled by the web runtime, and the file queue is not safe for multiple
hosts.

Implemented:

- Provider-neutral identity, workspace roles, and authorization contracts.
- Local single-workspace auth plus shared-secret gateway claims for controlled
  OIDC/SAML front doors.
- Workspace-scoped reads, downloads, events, asset listing, and mutations.
- Strict approved-host URL policy with credential, port, DNS, and private-range
  rejection, checked again by the worker.
- Bounded extension and magic-byte upload validation, streaming persistence
  after framework multipart parsing, and failed-upload cleanup.
- Per-job work/output directories, managed artifact containment, retries,
  attempt counters, leases, cancellation intent, terminal-state race guards,
  and cleanup.
- Docker packaging, liveness endpoint, and focused security regression tests.

Deferred to Phase 1:

- Resumable direct-to-object-storage uploads and checksums for large objects.
- PostgreSQL-backed audit persistence.
- Shared durable queue, multi-host leases, dead-letter management, and
  distributed progress events.

Exit criteria for this phase: no unauthenticated resource access through the
job/asset APIs, no cross-workspace reads, no arbitrary internal URL fetches,
and failed work cannot silently overwrite successful or cancelled work. These
controls are now enforced in the current runtime; production deployment still
requires a trusted identity gateway rather than `MOCAP_AUTH_MODE=local`.

### Phase 1: Durable platform foundation

Status: baseline implemented for the self-hosted Docker deployment. The web
control plane now persists job metadata in PostgreSQL, media/artifacts in an
S3-compatible store, and dispatches work through Redis/BullMQ to a separate
worker process. The legacy file queue remains available for lightweight local
development only.

Implemented in this slice:

- PostgreSQL schema, migrations, tenant-scoped job repository, canonical
  workspace membership checks, and atomic worker claim/finish/failure
  transitions.
- MinIO/S3-compatible object storage adapter with tenant-prefixed keys,
  streamed uploads, signed downloads, and multipart URL primitives.
- Redis/BullMQ queue adapter with retries, backoff, progress reporting, and
  cancellation dispatch.
- Dedicated `apps/worker` process that downloads source objects, runs the core
  pipeline, uploads immutable motion artifacts, and finalizes job state.
- Durable-mode API branches for upload, URL submission, list/detail, cancel,
  delete, download, and SSE progress polling.
- Docker Compose services for PostgreSQL, Redis, MinIO, web, and worker with
  health-based startup ordering.

Still required before calling the phase enterprise-complete:

- Multipart checksum enforcement and a dedicated upload-session cleanup worker;
  browser-to-object-storage sessions, persisted session state, retry/resume,
  exact part-size validation, and final object signature checks are now in
  place, while the legacy form route remains available as a fallback.
- Lease reaper/heartbeat scheduling and dead-letter inspection are now in place;
  remaining operational work covers distributed events, observability,
  retention, backups, and restore drills.
- Distributed event delivery, observability, retention jobs, backups, and
  restore drills.
- Separate GPU/render worker images as those processing capabilities land.

Membership-backed authorization is now enforced for durable operations: header
claims identify the principal, while PostgreSQL workspace membership is the
canonical role source. Durable workers now use fenced leases and heartbeats;
expired attempts are atomically re-queued or terminally failed, and owner/admin
operators can inspect and deliberately redrive dead-letter jobs through the
operational API.

Deferred operational work:

- Distributed event delivery, observability, retention jobs, backups, and
  restore drills.
- Separate GPU/render worker images as those processing capabilities land.

Exit criteria for this implemented baseline: web instances can scale apart from
CPU workers, source files and outputs do not depend on web-local disks, and a
worker crash leaves a database row eligible for retry. Full enterprise exit
criteria additionally require the deferred controls above.

### Phase 2: Motion engine quality

Goal: make output dependable for production use, not merely visually plausible.

- Introduce a `PoseBackend` interface and a model registry.
- Version every model, profile, solver, and exporter.
- Improve depth estimation and camera/scale calibration.
- Add robust multi-person identity tracking with frame alignment.
- Add real hands, fingers, and face backends.
- Add occlusion-aware temporal solving.
- Implement actual foot and hand contact constraints.
- Add rig rest-pose correction and character-specific retarget profiles.
- Produce quality reports and capture recommendations.
- Add benchmark clips and regression metrics for every model release.

Exit criteria: every take has measurable confidence, warnings, reproducible
settings, and a known quality envelope.

### Phase 3: Non-destructive 3D video workspace

Goal: let users create and revise animated 3D videos inside the product.

- Project and timeline APIs backed by the workspace contracts.
- Character library and rig validation service.
- Scene/environment library.
- Timeline editor with character tracks and motion clips.
- Interactive WebGL preview with camera and scene controls.
- Render queue for MP4, WebM, and image sequences.
- Audio and timecode alignment.
- Version snapshots, comments, review, and approval.
- Compare and branch timelines without destroying prior work.

Exit criteria: a user can make a short scene from multiple characters and
motion takes, render it, revise it, and identify exactly which source and
settings produced the final video.

### Phase 4: Enterprise and ecosystem

Goal: serve studios and automated production pipelines.

- OIDC and SAML SSO.
- SCIM provisioning and group-to-role mapping.
- Service accounts, API keys, webhooks, and batch APIs.
- Fine-grained project and asset permissions.
- Usage metering, quotas, and billing.
- Data residency, retention policies, legal holds, and deletion attestations.
- Customer-managed keys and private networking options.
- Blender, Unreal, Unity, and DCC integrations.
- Enterprise support, SLA reporting, backup restore drills, and incident runbooks.

## Priority Decisions

1. Keep `FileJobQueue` for local development only.
2. Make PostgreSQL/object storage/queue adapters explicit interfaces.
3. Treat all media as untrusted input.
4. Keep processing asynchronous and independently deployable.
5. Make model and output versions immutable and inspectable.
6. Build the timeline/render domain before adding many UI toggles.
7. Benchmark motion quality continuously against labeled reference clips.
8. Use a provider-neutral core so hosted and self-hosted deployments share logic.

## Research Basis

The product benchmark was based on current official material from:

- [DeepMotion Animate 3D](https://www.deepmotion.com/animate-3d): multi-person
  tracking, custom FBX/GLB/VRM characters, automatic retargeting, face/hand
  tracking, physics, foot locking, rotoscope correction, exports, API, and SDK.
- [DeepMotion documentation](https://www.deepmotion.com/doc/animate-3d): capture
  guidance and production-oriented motion cleanup settings.
- [Rokoko Vision 3.0](https://www.rokoko.com/products/vision): video upload,
  cleanup, looping, custom characters, HIK/Mixamo retargeting, FBX/BVH export,
  storage, and the distinction between AI post-processing and real-time hardware.
- [Move API models](https://developers.move.ai/docs/models/): separate
  single-camera, multi-camera, high-volume, hand-tracking, and enterprise
  real-time models.
- [OWASP ASVS 5.0](https://owasp.org/www-project-application-security-verification-standard/):
  security verification requirements for modern web applications.
- [OWASP Multi-Tenant Security](https://cheatsheetseries.owasp.org/cheatsheets/Multi_Tenant_Security_Cheat_Sheet.html):
  tenant isolation, IDOR, noisy-neighbor, authorization, and audit guidance.
- [Amazon S3 multipart uploads](https://docs.aws.amazon.com/AmazonS3/latest/userguide/mpuoverview.html):
  resumability, retries, checksums, and lifecycle handling for large objects.
- [OpenTelemetry observability primer](https://opentelemetry.io/docs/concepts/observability-primer/):
  correlated traces, metrics, and logs for distributed systems.
