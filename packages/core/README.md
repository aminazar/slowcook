# @slowcook-ai/core

Core types and pure logic for the slowcook brewing harness.

This package contains no I/O. Everything runs on plain data so it's trivially testable and usable from any runtime (CLI, worker daemon, dashboard API, future GitLab adapter). I/O glue (reading git, parsing configs, writing PR summaries) lives in the CLI and forge adapters.

## What's in 0.2

- **Frozen paths (0.1)**: `checkFrozenPaths(changed, config)` — detects directory, exact-file, and partial-JSON-key violations.
- **Manifests (0.2)**: `buildManifest(args)`, `diffManifest(recorded, currentTests)`, plus `Manifest`, `TestEntry`, `SuiteRecord`, `ManifestDiff` types — schema-versioned snapshots of discoverable tests and pure-function diff logic for `manifest record` / `manifest verify`.

See the monorepo [README](../../README.md) for the big picture and the [design doc](../../docs/DESIGN.md) for where this fits in the full pipeline.

## License

MIT
