/**
 * Slowcook brand assets — single source-of-truth.
 *
 * The canonical file is `packages/core/assets/slowcook-logo.svg`. This
 * module reads it at module load and exports the SVG markup as a
 * string so other packages (`mock-runtime`, `cli`) consume the same
 * bytes without inlining their own copies.
 *
 * Edit the .svg file (it's previewable in editors / browsers); the
 * string export reflects the file content at the next process start.
 *
 * The published `@slowcook-ai/core` tarball includes the `assets/`
 * directory (see `files` in package.json).
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// __dirname-equivalent in ESM.
const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Resolves the published tarball layout:
 *   @slowcook-ai/core/
 *     dist/branding.js   ← this file at runtime
 *     assets/slowcook-logo.svg
 * `dist/` is at the same depth as `assets/`, so `../assets/...` lands.
 */
const LOGO_PATH = join(__dirname, "..", "assets", "slowcook-logo.svg");

/**
 * The slowcook logo as SVG markup. Coral pot (#FF6B6B) on a transparent
 * background. Consumers render via `<img src=...>`, `dangerouslySetInnerHTML`,
 * or write to disk (the `slowcook init mock` template does the latter).
 *
 * The fill is the slowcook brand coral, regardless of the consumer's
 * brand primary — this mark represents slowcook itself, not the
 * consumer.
 */
export const SLOWCOOK_LOGO_SVG: string = readFileSync(LOGO_PATH, "utf8");
