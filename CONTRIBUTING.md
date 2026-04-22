# Contributing to mocap-ts

Thanks for your interest! Contributions of all sizes are welcome — bug reports, docs, tests, and code.

## Reporting bugs

Open an issue with:
- The command / code you ran
- The input (link or describe — don't upload anything you don't own the rights to)
- The actual vs. expected output
- Node version, OS, and ffmpeg version (`ffmpeg -version`)

## Proposing changes

For non-trivial work (new exporters, new IK approaches, breaking API changes), **open an issue first** so we can align on direction before you spend time.

For small fixes (typos, obvious bugs, docs), just open a PR.

## Development setup

```bash
git clone https://github.com/ellyseum/mocap_ts.git
cd mocap_ts
pnpm install
pnpm run build
pnpm test
```

System deps: Node ≥20, pnpm 9+, ffmpeg. `yt-dlp` is only needed if you're touching URL ingestion.

## Pull request checklist

- [ ] `pnpm run build` passes (no TypeScript errors)
- [ ] `pnpm test` passes
- [ ] New behavior has tests — the existing bar is roughly 1:1 source-to-test LOC
- [ ] Public API changes are reflected in `README.md` and `CHANGELOG.md` (under `[Unreleased]`)
- [ ] Commit messages follow [Conventional Commits](https://www.conventionalcommits.org/) (`feat:`, `fix:`, `refactor:`, `docs:`, `test:`, `chore:`)

## Code style

- TypeScript strict mode is on; no `any` without a `// eslint-disable` justification.
- Prefer pure functions in `math/`, `skeleton/`, and `export/` — they're easy to test and reason about.
- Side-effectful code (ffmpeg invocation, file I/O, TF.js model loading) lives at the edges in `video/`, `pose/`, and `pipeline.ts`.

## License

By contributing, you agree that your contributions will be licensed under the [MIT License](./LICENSE).
