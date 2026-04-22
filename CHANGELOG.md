# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] - 2026-04-21

### Added
- Initial release of the TypeScript mocap pipeline.
- Video / frame-directory / URL input via ffmpeg + yt-dlp.
- TF.js pose estimation with optional hand tracking.
- EMA temporal smoother.
- Per-subject skeleton calibration from estimated keypoints.
- Quaternion-based IK solver with frame-to-frame continuity.
- BVH export.
- CLI (`mocap-ts`) with `--input`, `--output`, `--fps`, `--hands`/`--no-hands`, `--smoothing`, `--verbose`.
- Blender preview script (`render_bvh.py`) using vertex groups + Armature deform.
- 88 unit/integration tests across math, pose, skeleton, IK, and export modules.

[Unreleased]: https://github.com/ellyseum/mocap_ts/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/ellyseum/mocap_ts/releases/tag/v0.1.0
