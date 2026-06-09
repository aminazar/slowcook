/**
 * 0.19.0+ (sc#82) — mock-shape detection.
 *
 * Reads `.brewing/mock.yaml` to tell downstream agents (vibe, plate,
 * recon, port, run-mock) which mock shape the consumer is on. Defaults
 * to `nextjs` when the file is absent — preserves backwards-compat with
 * pre-sc#82 consumers whose mock predates the config.
 *
 * Single source of truth so every agent reads + writes consistent
 * conventions: paths to screens, design-system dir, router file,
 * scenario registry. Nothing else should hard-code these locations.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import { z } from "zod";

const MockShapeConfigSchema = z.object({
  schema_version: z.literal(1),
  shape: z.enum(["vite", "nextjs"]),
  mock_root: z.string().default("mock"),
  screens_root: z.string().default("mock/src/apps"),
  design_system_dir: z.string().default("mock/src/design-system"),
  router_file: z.string().optional(),
  scenarios_dir: z.string().default("mock/scenarios"),
  scenario_registry_file: z.string().default("mock/src/lib/scenario-registry.ts"),
  /**
   * 0.6.0 — review surface shape for the overlay (run-mock passes it to
   * the overlay via NEXT_PUBLIC_SLOWCOOK_REVIEW_MODE).
   *
   *  - `"scenarios"` (default): a scenario-picker mock; the overlay hides
   *    on `/` and comments key by story_id.
   *  - `"lcr"`: a full navigable Living Coded Requirement; the overlay
   *    shows on every route and each comment captures its route so plate
   *    amends per-page. GUCDI mocks set this.
   */
  review_mode: z.enum(["scenarios", "lcr"]).default("scenarios"),
});

export type MockShapeConfig = z.infer<typeof MockShapeConfigSchema>;

const NEXTJS_DEFAULT: MockShapeConfig = {
  schema_version: 1,
  shape: "nextjs",
  mock_root: "mock",
  screens_root: "mock/src/app",
  design_system_dir: "mock/src/design-system",
  scenarios_dir: "mock/scenarios",
  scenario_registry_file: "mock/src/lib/scenario-registry.ts",
  review_mode: "scenarios",
};

const VITE_DEFAULT: MockShapeConfig = {
  schema_version: 1,
  shape: "vite",
  mock_root: "mock",
  screens_root: "mock/src/apps",
  design_system_dir: "mock/src/design-system",
  router_file: "mock/src/App.tsx",
  scenarios_dir: "mock/scenarios",
  scenario_registry_file: "mock/src/lib/scenario-registry.ts",
  review_mode: "scenarios",
};

/**
 * Load `.brewing/mock.yaml`. Returns a default config when the file is
 * absent (preserves backwards-compat with pre-sc#82 consumers). Throws
 * on parse error / schema violation so a mis-authored config surfaces
 * loudly rather than silently disabling features.
 */
export function loadMockShapeConfig(repoRoot: string): MockShapeConfig {
  const p = join(repoRoot, ".brewing", "mock.yaml");
  if (!existsSync(p)) {
    // Heuristic fallback: if mock/src/app/ exists (Next.js convention),
    // treat as nextjs. If mock/src/App.tsx exists (Vite convention),
    // treat as vite. Otherwise nextjs for legacy safety.
    const viteAppFile = join(repoRoot, "mock", "src", "App.tsx");
    if (existsSync(viteAppFile)) return VITE_DEFAULT;
    return NEXTJS_DEFAULT;
  }
  const raw = YAML.parse(readFileSync(p, "utf8"));
  const parsed = MockShapeConfigSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(
      `Invalid .brewing/mock.yaml: ${parsed.error.issues.map((i) => i.message).join("; ")}`,
    );
  }
  return parsed.data;
}

/**
 * Returns true when the consumer is on the Vite mock shape. Most
 * agents only need this binary; full config is for path lookups.
 */
export function isViteMock(repoRoot: string): boolean {
  return loadMockShapeConfig(repoRoot).shape === "vite";
}
