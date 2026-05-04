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

// Match any import from @slowcook-ai/mock-runtime — capture the full
// named-import list. Port rewrites useScenarioFixture → useDataDomain,
// drops mock-only hooks (useScenario, useScenarioRunner) entirely
// (they have no prod analog), and routes any unknown names through
// a no-op shim path so the rewritten file still compiles.
const MOCK_RUNTIME_IMPORT_RE =
  /import\s+\{\s*([^}]+)\s*\}\s+from\s+["']@slowcook-ai\/mock-runtime["'];?\s*\n/g;

const SCENARIO_USE_RE = /\buseScenarioFixture\b/g;

// Hooks/utilities defined ONLY in mock-runtime — brew can't satisfy
// these in prod. Port replaces calls with safe no-ops + drops the
// import. Each of these returns a plausible "no scenario active"
// value so the component tree still renders.
const MOCK_ONLY_NAMES_TO_DROP = new Set([
  "useScenario",
  "useScenarioRunner",
  "ScenarioRegistryProvider",
]);

/**
 * Apply all port-time source transforms to a single file's contents.
 * Returns the transformed body + the list of rewrites that fired.
 */
export function transformForPort(input: string, opts?: { storyId?: string }): PortTransformResult {
  let output = input;
  const rewrites: string[] = [];

  // 1) Rewrite mock-runtime imports. Three cases per imported name:
  //    - useScenarioFixture → useDataDomain (real hook brew implements)
  //    - useScenario, useScenarioRunner, ScenarioRegistryProvider:
  //         drop the import; replace call sites with safe no-ops below
  //    - anything else: pass through into a residual mock-runtime
  //         import line (rare; signals the consumer hand-extended)
  if (MOCK_RUNTIME_IMPORT_RE.test(output)) {
    MOCK_RUNTIME_IMPORT_RE.lastIndex = 0;
    output = output.replace(MOCK_RUNTIME_IMPORT_RE, (_match, namedListRaw) => {
      const names = String(namedListRaw)
        .split(",")
        .map((s: string) => s.trim())
        .filter((s: string) => s.length > 0);
      const wantsDataDomain = names.includes("useScenarioFixture");
      const residual = names.filter(
        (n: string) => n !== "useScenarioFixture" && !MOCK_ONLY_NAMES_TO_DROP.has(n)
      );
      const lines: string[] = [];
      if (wantsDataDomain) {
        lines.push(`import { useDataDomain } from "@/lib/data";`);
      }
      if (residual.length > 0) {
        lines.push(`import { ${residual.join(", ")} } from "@slowcook-ai/mock-runtime";`);
      }
      // If only mock-only names were imported, the result is a single
      // empty line (the import is dropped entirely). Caller's call sites
      // are no-op'd by the next transform step.
      return lines.length > 0 ? lines.join("\n") + "\n" : "";
    });
    rewrites.push("rewrote @slowcook-ai/mock-runtime imports (useScenarioFixture→useDataDomain; mock-only names dropped)");
  }

  // 2) Rewrite useScenarioFixture call sites → useDataDomain.
  if (SCENARIO_USE_RE.test(output)) {
    SCENARIO_USE_RE.lastIndex = 0;
    output = output.replace(SCENARIO_USE_RE, "useDataDomain");
    rewrites.push("rewrote useScenarioFixture(...) → useDataDomain(...)");
  }

  // 2b) Replace mock-only hook call sites with safe no-ops so the
  //     rewritten file still compiles when the component reads
  //     `scenario?.user` etc. Pattern: `useScenario()` → `(null as
  //     { user: { id: string } | null } | null)`. Conservative: only
  //     rewrite the bare call expression; if vibe was creative with the
  //     usage (destructuring directly from the call), brew will see a
  //     parse error and can adapt.
  for (const name of MOCK_ONLY_NAMES_TO_DROP) {
    const callRe = new RegExp(`\\b${name}\\s*\\(\\s*\\)`, "g");
    if (callRe.test(output)) {
      callRe.lastIndex = 0;
      // Replace with `null` typed broadly so destructuring + member
      // access stays type-safe. Brew rewires real auth in src/.
      output = output.replace(callRe, `(null as any /* ${name}() — mock-only; brew wires real source */)`);
      rewrites.push(`stubbed mock-only ${name}() call sites → null`);
    }
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
 *
 * Note: collisions with the consumer's hand-written src/ files (e.g.
 * mock/src/app/layout.tsx vs the consumer's real src/app/layout.tsx)
 * are NOT filtered here. The walker handles them at write-time by
 * checking for the @slowcook-port-from marker on the destination —
 * unmarked destinations are skipped, never overwritten. That keeps
 * this mapping a pure path translation (no hardcoded shell list).
 */
export function mockPathToSrcPath(mockPath: string): string | null {
  if (!mockPath.startsWith("mock/")) return null;

  // Mock-only files: scenarios + scenario registry never port.
  if (mockPath.startsWith("mock/scenarios/")) return null;
  if (mockPath === "mock/src/lib/scenario-registry.ts") return null;
  if (mockPath.startsWith("mock/src/lib/scenario-registry/")) return null;

  // mock/src/* → src/* ; mock/<other>/* → don't port (only src/ maps cleanly).
  if (mockPath.startsWith("mock/src/")) {
    return "src/" + mockPath.slice("mock/src/".length);
  }
  return null;
}

/**
 * File-level skip marker. A mock file that contains
 * `@slowcook-port-skip` in its first 20 lines is treated as
 * mock-only — port walks past it without writing anything in src/.
 *
 * Use this for mock-only shims (e.g. a `mock/src/lib/mock-foo.ts`
 * that exists only so the mock app builds; the corresponding prod
 * code lives elsewhere).
 */
export function isMockOnlyFile(input: string): boolean {
  const head = input.split("\n", 20).join("\n");
  return /@slowcook-port-skip\b/.test(head);
}
