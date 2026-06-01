/**
 * Profile auto-detection — Trade-off #4 resolution.
 *
 * `serve mock` is only meaningful if the consumer's `mock/` package is
 * vite-runnable (has `scripts.dev`). If it isn't, slowcook prints a
 * notice + exits 0 instead of trying to bring up an unrunnable profile.
 *
 * Exported as a pure function so the index.ts dispatcher + future
 * `slowcook serve mock init` scaffolding can reuse the same check.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface MockRunnableResult {
  /** Whether `mock/` exists at all. */
  exists: boolean;
  /** Whether `mock/package.json` declares `scripts.dev`. */
  hasDevScript: boolean;
  /** The dev script's command, when present. */
  devScript?: string;
  /** When `false`, a one-line reason suitable for `console.log`. */
  reason?: string;
}

/**
 * Inspect `<repoRoot>/mock/package.json` and report whether the
 * consumer has a vite-runnable mock app.
 *
 * Why this check: many slowcook consumers have a `mock/` directory
 * that's only used as a vibe-time artefact (no runtime). For those
 * consumers, `serve mock up` would fail trying to docker-compose a
 * non-existent vite-dev process. Skip cleanly instead.
 */
export function detectMockRunnable(repoRoot: string): MockRunnableResult {
  const pkgPath = join(repoRoot, "mock", "package.json");
  if (!existsSync(pkgPath)) {
    return {
      exists: false,
      hasDevScript: false,
      reason: "mock/ directory absent — `serve mock` requires a runnable mock app.",
    };
  }
  let pkg: { scripts?: Record<string, string> };
  try {
    pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
  } catch (e) {
    return {
      exists: true,
      hasDevScript: false,
      reason: `mock/package.json is not valid JSON: ${(e as Error).message}`,
    };
  }
  const devScript = pkg.scripts?.dev;
  if (!devScript) {
    return {
      exists: true,
      hasDevScript: false,
      reason:
        "mock/package.json has no `scripts.dev` — declare one (e.g. `vite`) to enable the `serve mock` profile.",
    };
  }
  return {
    exists: true,
    hasDevScript: true,
    devScript,
  };
}
