/**
 * Port-time source transforms — 0.16.0-α.8.
 *
 * `slowcook port` is the deterministic mock → src copy step. It walks
 * mock/src/components/ + mock/src/app/, copies each file to the
 * mirrored src/ path, and applies a small set of import + hook
 * rewrites so the production component reads its data from the real
 * Supabase layer instead of the mock-runtime scenarios.
 *
 * The transform is intentionally narrow:
 *
 *   import { useScenarioFixture } from "@slowcook-ai/mock-runtime";
 *     ↓
 *   import { useDataDomain } from "@/lib/data";
 *
 *   const x = useScenarioFixture<T>("pins");
 *     ↓
 *   const x = useDataDomain<T>("pins");
 *
 * The new `@/lib/data#useDataDomain` is brew's territory (α.9 writes
 * the real implementation against Supabase). At port-time, all that
 * exists in src/lib/data/ may be a stub `useDataDomain` — brew fills
 * the body. That keeps tests red until brew's done.
 *
 * Pure functions over strings. No fs access. Same input → same output.
 */

export interface PortTransformResult {
  /** New file body. */
  output: string;
  /** Each rewrite that fired (for the audit-trail commit message). */
  rewrites: string[];
}

const SCENARIO_FIXTURE_IMPORT_RE =
  /import\s+\{\s*useScenarioFixture\s*(?:,\s*([^}]*))?\}\s+from\s+["']@slowcook-ai\/mock-runtime["'];?\s*\n/g;

const SCENARIO_USE_RE = /\buseScenarioFixture\b/g;

/**
 * Apply all port-time source transforms to a single file's contents.
 * Returns the transformed body + the list of rewrites that fired.
 */
export function transformForPort(input: string, opts?: { storyId?: string }): PortTransformResult {
  let output = input;
  const rewrites: string[] = [];

  // 1) Rewrite mock-runtime imports → src/lib/data import.
  if (SCENARIO_FIXTURE_IMPORT_RE.test(output)) {
    SCENARIO_FIXTURE_IMPORT_RE.lastIndex = 0;
    output = output.replace(
      SCENARIO_FIXTURE_IMPORT_RE,
      (_m, otherImports) => {
        if (otherImports && otherImports.trim()) {
          // Other named imports stayed too — preserve them as a separate
          // mock-runtime import line. Conservative: rare in mock components
          // (most use only useScenarioFixture).
          return (
            `import { useDataDomain } from "@/lib/data";\n` +
            `import { ${otherImports.trim()} } from "@slowcook-ai/mock-runtime";\n`
          );
        }
        return `import { useDataDomain } from "@/lib/data";\n`;
      }
    );
    rewrites.push("rewrote @slowcook-ai/mock-runtime → @/lib/data import");
  }

  // 2) Rewrite useScenarioFixture call sites → useDataDomain.
  if (SCENARIO_USE_RE.test(output)) {
    SCENARIO_USE_RE.lastIndex = 0;
    output = output.replace(SCENARIO_USE_RE, "useDataDomain");
    rewrites.push("rewrote useScenarioFixture(...) → useDataDomain(...)");
  }

  // 3) Strip the `// @slowcook-mock-only` markers so the production
  // file doesn't carry mock-only annotations (vibe sometimes adds
  // these to flag temporary structures).
  if (/^\s*\/\/\s*@slowcook-mock-only\b.*$/m.test(output)) {
    output = output.replace(/^\s*\/\/\s*@slowcook-mock-only\b.*$\n?/gm, "");
    rewrites.push("stripped // @slowcook-mock-only markers");
  }

  // 4) Insert a port-provenance header so future readers know which
  // story shipped this file. Skipped when one already exists.
  if (opts?.storyId && !/@slowcook-port-from\b/.test(output)) {
    const header =
      `// @slowcook-port-from mock/ (story-${opts.storyId})\n` +
      `// Copied by \`slowcook port\` from the mock app.\n` +
      `// UI shape is the design contract; brew (--mode plate) writes the\n` +
      `// data layer + handlers but does NOT touch this file.\n`;
    output = output.replace(/^("use client";?\s*\n)?/, (m) => (m ?? "") + header);
    rewrites.push(`prepended port-provenance header (story-${opts.storyId})`);
  }

  return { output, rewrites };
}

/**
 * Translate a `mock/<rest>` path into the corresponding `src/<rest>`
 * path. Used by the file walker.
 *
 * Examples:
 *   mock/src/components/rewo/RewoCard.tsx  →  src/components/rewo/RewoCard.tsx
 *   mock/src/app/(main)/u/[handle]/page.tsx → src/app/(main)/u/[handle]/page.tsx
 *   mock/src/lib/scenario-registry.ts  →  null  (mock-only; never ports)
 *   mock/scenarios/story-017.ts        →  null  (mock-only; never ports)
 */
export function mockPathToSrcPath(mockPath: string): string | null {
  if (!mockPath.startsWith("mock/")) return null;

  // Mock-only files: scenarios + scenario registry never port.
  if (mockPath.startsWith("mock/scenarios/")) return null;
  if (mockPath === "mock/src/lib/scenario-registry.ts") return null;
  if (mockPath.startsWith("mock/src/lib/scenario-registry/")) return null;

  // 0.16.0-α.26 — mock-app-shell files: scaffolded by `slowcook init
  // mock` (NOT story-specific UI). Never port — they would clobber the
  // consumer's production app shell:
  //   layout.tsx — mounts ScenarioRegistryProvider + overlay; consumer's
  //                src/app/layout.tsx is THEIR production app shell
  //   page.tsx   — the picker UI (homepage); consumer has their own
  //   globals.css — mock's tailwind directives + tokens
  if (mockPath === "mock/src/app/layout.tsx") return null;
  if (mockPath === "mock/src/app/page.tsx") return null;
  if (mockPath === "mock/src/app/globals.css") return null;

  // mock/src/* → src/* ; mock/<other>/* → don't port (only src/ maps cleanly).
  if (mockPath.startsWith("mock/src/")) {
    return "src/" + mockPath.slice("mock/src/".length);
  }
  return null;
}
