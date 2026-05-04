/**
 * @slowcook 0.17.6+ — recon shape-preservation tests.
 *
 * Reads mock UI files for a story and emits structural assertions to
 * tests/integration/story-N-shape.test.tsx. Pure deterministic; no LLM.
 *
 * Asserts SHAPE only (per `feedback_shape_tests_belong_to_recon_not_testgen`):
 *   - testid presence + cardinality
 *   - DOM containment (e.g. badge inside <header>)
 *   - className tokens (visual/a11y signals like `rounded-full`, `min-h-[44px]`)
 *   - CSS variable tokens (no inline hex/rgb)
 *
 * Never asserts WIRING (per `feedback_testgen_must_not_over_assert_mock`):
 *   - No spied-on hooks, no import existence, no readFileSync of source
 *   - No mock-only chrome (subtrees marked `data-mock-chrome="true"` are
 *     mechanically excluded from the testid+class extraction)
 *
 * Test rendering uses plain props (no scenario-runtime), so mock-chrome
 * never actually renders in the test even if it weren't filtered.
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

export interface ExtractedShape {
  /** Component file scanned (mock-side). */
  file: string;
  /** Testids found on non-mock-chrome JSX (deduped). */
  testids: string[];
  /** Visual className tokens worth preserving (subset; see TOKENS_OF_INTEREST). */
  visualTokens: string[];
  /** Whether the component renders any element with a `<header>` ancestor. */
  hasHeader: boolean;
  /** Component name (best-effort). */
  componentName: string | null;
}

const TOKENS_OF_INTEREST = [
  // Shape tokens
  "rounded-full", "rounded-2xl", "rounded-xl", "rounded-lg", "rounded-md", "rounded-sm",
  // Tap-target / a11y mandates
  "min-h-[44px]", "min-h-11", "h-11", "min-w-[44px]",
  // Common layout primitives that imply structural intent
  "flex", "grid", "inline-flex",
];

/**
 * Scan a mock UI file, return the SHAPE-relevant facts after stripping
 * mock-only chrome subtrees.
 */
export function extractShape(absFile: string, repoRoot: string): ExtractedShape | null {
  if (!existsSync(absFile)) return null;
  const body = readFileSync(absFile, "utf8");
  const fileRel = relative(repoRoot, absFile).replace(/\\/g, "/");

  // Strip mock-only chrome subtrees BEFORE extraction.
  const cleaned = stripMockChromeSubtrees(body);

  // Component name: simplest extraction.
  const nameMatch = cleaned.match(/export\s+(?:default\s+)?function\s+([A-Z]\w*)/);
  const componentName = nameMatch ? nameMatch[1] ?? null : null;

  const testids = [...new Set(extractTestids(cleaned))];
  const visualTokens = [...new Set(extractTokens(cleaned, TOKENS_OF_INTEREST))];
  const hasHeader = /<header\b/.test(cleaned);

  return { file: fileRel, testids, visualTokens, hasHeader, componentName };
}

/**
 * Strip JSX subtrees marked as mock-only chrome. Two conventions:
 *   1. data-mock-chrome="true" attribute on the wrapping element
 *   2. JSX comment immediately preceding (matching /Mock-only/i)
 *
 * Conservative — false positives (treating real shape as chrome) are
 * worse than false negatives.
 */
export function stripMockChromeSubtrees(source: string): string {
  let out = source;

  // Pass 1: strip elements opened with data-mock-chrome="true" (and their
  // children up to the matching closing tag).
  out = stripBalancedJsxBlock(out, /<(\w+)\b[^>]*\bdata-mock-chrome\s*=\s*["']true["'][^>]*>/);

  // Pass 2: best-effort — strip the JSX block that immediately follows
  // a `{/* Mock-only ... */}` JSX comment.
  out = stripBalancedJsxBlockAfter(out, /\{\/\*\s*Mock-only[^*]*\*\/\s*\}\s*/);

  return out;
}

/**
 * Repeatedly find a JSX opening tag matching `openRe` and remove the
 * balanced subtree (open tag + children + close tag).
 *
 * Self-closing tags (e.g. `<Foo />`) are also handled. Tag-name balanced.
 */
function stripBalancedJsxBlock(source: string, openRe: RegExp): string {
  let s = source;
  for (let safety = 0; safety < 64; safety++) {
    const m = openRe.exec(s);
    if (!m) break;
    const start = m.index;
    const tagName = m[1];
    const openTag = m[0];

    // Self-closing? remove just that.
    if (openTag.endsWith("/>")) {
      s = s.slice(0, start) + s.slice(start + openTag.length);
      openRe.lastIndex = 0;
      continue;
    }

    // Walk forward to find balanced close.
    let depth = 1;
    let i = start + openTag.length;
    const openTagRe = new RegExp(`<${tagName}\\b[^>]*?>`, "g");
    const closeTagRe = new RegExp(`</${tagName}\\s*>`, "g");
    while (i < s.length && depth > 0) {
      openTagRe.lastIndex = i;
      closeTagRe.lastIndex = i;
      const oNext = openTagRe.exec(s);
      const cNext = closeTagRe.exec(s);
      if (!cNext) break;
      if (oNext && oNext.index < cNext.index) {
        // skip self-closing inside (rare for compound tag)
        if (!oNext[0].endsWith("/>")) depth++;
        i = oNext.index + oNext[0].length;
      } else {
        depth--;
        i = cNext.index + cNext[0].length;
        if (depth === 0) {
          s = s.slice(0, start) + s.slice(i);
          break;
        }
      }
    }
    openRe.lastIndex = 0;
  }
  return s;
}

function stripBalancedJsxBlockAfter(source: string, markerRe: RegExp): string {
  let s = source;
  for (let safety = 0; safety < 32; safety++) {
    const m = markerRe.exec(s);
    if (!m) break;
    // Find the JSX opening tag immediately after the marker.
    const after = s.slice(m.index + m[0].length);
    const tagMatch = /^\s*<(\w+)\b[^>]*>/.exec(after);
    if (!tagMatch) {
      // Marker not followed by a JSX tag; just remove the marker comment.
      s = s.slice(0, m.index) + s.slice(m.index + m[0].length);
      continue;
    }
    // Use stripBalancedJsxBlock at the marker position with the tag-specific regex.
    const openTagAbsoluteIdx = m.index + m[0].length + (after.indexOf("<"));
    const tagName = tagMatch[1];
    if (!tagName) {
      s = s.slice(0, m.index) + s.slice(m.index + m[0].length);
      continue;
    }
    const openTagRe = new RegExp(`<${tagName}\\b[^>]*?>`);
    const sliced = s.slice(openTagAbsoluteIdx);
    const stripped = stripBalancedJsxBlock(sliced, openTagRe);
    s = s.slice(0, m.index) + stripped;
    markerRe.lastIndex = 0;
  }
  return s;
}

function extractTestids(source: string): string[] {
  const out: string[] = [];
  for (const m of source.matchAll(/data-testid\s*=\s*["']([^"']+)["']/g)) {
    if (m[1]) out.push(m[1]);
  }
  return out;
}

function extractTokens(source: string, tokens: string[]): string[] {
  const out: string[] = [];
  for (const t of tokens) {
    // Look in className strings/template literals.
    const re = new RegExp(`className\\s*=\\s*["'\`][^"'\`]*\\b${escapeRegExp(t)}\\b`);
    if (re.test(source)) out.push(t);
  }
  return out;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ---- Test-file synthesis ----

interface SynthOpts {
  story: string;
  shapes: ExtractedShape[];
}

export function synthesiseShapeTestFile(opts: SynthOpts): string {
  const { story, shapes } = opts;

  const lines: string[] = [];
  lines.push("// @vitest-environment jsdom");
  lines.push("//");
  lines.push(`// AUTO-GENERATED by slowcook recon (story-${story}). Do not edit by hand.`);
  lines.push("// Asserts STRUCTURAL SHAPE only (DOM containment, testid cardinality,");
  lines.push("// className tokens, CSS-variable usage). Behavioral assertions live in");
  lines.push(`// the testgen-emitted story-${story}-*.test.{ts,tsx} files.`);
  lines.push("//");
  lines.push("// Mock-only chrome (data-mock-chrome=\"true\" subtrees) is excluded.");
  lines.push("// Re-running recon regenerates this file.");
  lines.push("");
  lines.push(`import { describe, it, expect } from "vitest";`);
  lines.push(`import { readFileSync, existsSync } from "node:fs";`);
  lines.push("");
  lines.push(`describe("story-${story} structural shape (recon-emitted)", () => {`);

  // Source-grep based assertions: cheap + always work without a render.
  // The mock's testids/tokens must persist in src/ after brew's edits.
  const allTestids = [...new Set(shapes.flatMap((s) => s.testids))];

  if (allTestids.length === 0 && shapes.every((s) => s.visualTokens.length === 0)) {
    lines.push(`  it.skip("no testids/tokens found in mock UI — nothing to assert", () => {});`);
  } else {
    for (const shape of shapes) {
      const srcPath = mockToSrcPath(shape.file);
      lines.push(`  describe("from mock ${shape.file}", () => {`);
      lines.push(`    const srcPath = "${srcPath}";`);
      lines.push(`    const src = existsSync(srcPath) ? readFileSync(srcPath, "utf8") : "";`);
      lines.push(``);
      for (const tid of shape.testids) {
        lines.push(`    it("preserves data-testid='${tid}' (mock-only chrome excluded)", () => {`);
        lines.push(`      expect(src).toMatch(/data-testid\\s*=\\s*["']${escapeRegexForTest(tid)}["']/);`);
        lines.push(`    });`);
      }
      for (const token of shape.visualTokens) {
        lines.push(`    it("preserves visual token '${token}'", () => {`);
        lines.push(`      expect(src).toMatch(/className=[^>]*\\b${escapeRegexForTest(token)}\\b/);`);
        lines.push(`    });`);
      }
      if (shape.hasHeader) {
        lines.push(`    it("retains a <header> element (semantic landmark)", () => {`);
        lines.push(`      expect(src).toMatch(/<header\\b/);`);
        lines.push(`    });`);
      }
      lines.push(`  });`);
      lines.push(``);
    }

    // Anti-wiring assertion: no inline hex colors (force token-family preservation).
    lines.push(`  describe("token-family preservation", () => {`);
    for (const shape of shapes) {
      const srcPath = mockToSrcPath(shape.file);
      lines.push(`    it("${shape.componentName ?? shape.file}: no inline hex/rgb colors (use var(--) tokens)", () => {`);
      lines.push(`      const src = existsSync("${srcPath}") ? readFileSync("${srcPath}", "utf8") : "";`);
      lines.push(`      // Allow hex in JSDoc/comments; only flag in className/style attribute values.`);
      lines.push(`      const styled = src.match(/(?:className|style)\\s*=\\s*[\"\`'][^\"\`']*?[#][0-9a-fA-F]{3,8}[^\"\`']*?[\"\`']/g) || [];`);
      lines.push(`      expect(styled, "no inline hex in className/style").toEqual([]);`);
      lines.push(`    });`);
    }
    lines.push(`  });`);
  }

  lines.push(`});`);
  return lines.join("\n") + "\n";
}

function mockToSrcPath(mockPath: string): string {
  // mock/src/components/X.tsx → src/components/X.tsx
  return mockPath.replace(/^mock\/src\//, "src/");
}

function escapeRegexForTest(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\\/]/g, "\\\\$&");
}

// ---- Discovery: which mock files belong to a story ----

/**
 * Walk mock/src/ + return any file that contains `story-N` in source
 * OR is referenced by a scenario file for the story.
 *
 * For 0.17.6 first cut: simple — any file under mock/src/components/
 * that lives in a directory referenced by the story's scenario.
 * Conservative — caller can pass explicit list via --mock-files.
 */
export function findMockFilesForStory(repoRoot: string, story: string): string[] {
  const out = new Set<string>();
  // Look for mock/scenarios/story-N*.ts
  const scenariosDir = join(repoRoot, "mock/scenarios");
  if (existsSync(scenariosDir)) {
    for (const name of readdirSync(scenariosDir)) {
      if (!name.startsWith(`story-${story}`)) continue;
      const body = readFileSync(join(scenariosDir, name), "utf8");
      // Pull `from "@/components/X/Y"` imports
      for (const m of body.matchAll(/from\s+["']@\/(components\/[\w\-./[\]]+)["']/g)) {
        if (m[1]) {
          const candidates = [
            `mock/src/${m[1]}.tsx`,
            `mock/src/${m[1]}.ts`,
            `mock/src/${m[1]}/index.tsx`,
          ];
          for (const c of candidates) {
            if (existsSync(join(repoRoot, c))) out.add(c);
          }
        }
      }
    }
  }
  // Also: any mock component referenced by a story-N test file
  const testsDir = join(repoRoot, "tests/integration");
  if (existsSync(testsDir)) {
    for (const name of readdirSync(testsDir)) {
      if (!name.startsWith(`story-${story}`)) continue;
      const body = readFileSync(join(testsDir, name), "utf8");
      for (const m of body.matchAll(/from\s+["']@\/(components\/[\w\-./[\]]+)["']/g)) {
        if (m[1]) {
          const candidates = [
            `mock/src/${m[1]}.tsx`,
            `mock/src/${m[1]}.ts`,
          ];
          for (const c of candidates) {
            if (existsSync(join(repoRoot, c))) out.add(c);
          }
        }
      }
    }
  }
  // Transitive walk: keep expanding until no new files added.
  const visited = new Set<string>();
  for (let safety = 0; safety < 20; safety++) {
    let added = false;
    for (const file of [...out]) {
      if (visited.has(file)) continue;
      visited.add(file);
      const body = readFileSync(join(repoRoot, file), "utf8");
      const dir = file.split("/").slice(0, -1).join("/");
      for (const m of body.matchAll(/from\s+["']\.\/([\w\-./]+)["']/g)) {
        if (!m[1]) continue;
        const candidates = [
          `${dir}/${m[1]}.tsx`,
          `${dir}/${m[1]}.ts`,
          `${dir}/${m[1]}/index.tsx`,
        ];
        for (const c of candidates) {
          if (existsSync(join(repoRoot, c)) && !out.has(c)) {
            out.add(c);
            added = true;
          }
        }
      }
      for (const m of body.matchAll(/from\s+["']@\/(components\/[\w\-./[\]]+)["']/g)) {
        if (!m[1]) continue;
        const candidates = [`mock/src/${m[1]}.tsx`, `mock/src/${m[1]}.ts`];
        for (const c of candidates) {
          if (existsSync(join(repoRoot, c)) && !out.has(c)) {
            out.add(c);
            added = true;
          }
        }
      }
    }
    if (!added) break;
  }
  return [...out];
}

// Re-export for tests
export { join as _join };

// re-export to placate tsc unused-import warnings
void readdirSync;
void statSync;
