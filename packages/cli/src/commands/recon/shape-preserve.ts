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
  /**
   * design #10 — dense, paradigm-aware per-element class facts. Unlike
   * `visualTokens` (filtered through the 17-item TOKENS_OF_INTEREST
   * allowlist), this captures the element's *actual* utility-class set so
   * the shape test can assert `brewed ⊇ mock` containment per element and
   * drift can't hide in unpinned classes. Optional + additive: absent on
   * hand-built fixtures and pre-#10 callers.
   */
  elementClasses?: ElementClassFacts[];
}

/** design #10 — one element's testid anchor + its utility-class tokens. */
export interface ElementClassFacts {
  /** data-testid on the element, or null (anchor for per-element assertions). */
  testid: string | null;
  /** Utility-shaped class tokens on the element (string-literal classNames only). */
  tokens: string[];
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
  const elementClasses = extractElementClasses(cleaned);

  return { file: fileRel, testids, visualTokens, hasHeader, componentName, elementClasses };
}

/**
 * design #10 — extract per-element utility-class facts from a (mock-chrome-
 * stripped) source. Paradigm-aware: only reads STRING-LITERAL classNames
 * (`className="..."` / `'...'` / plain backtick). `className={...}` brace
 * expressions — CSS-modules (`{styles.x}`), `cx(...)`, conditional template
 * literals with `${}` — are SKIPPED, because their tokens are either hashed
 * identifiers (noise, not design intent) or computed; extracting them would
 * be over-extraction. Styling fidelity for those mocks defers to the #8 eye.
 *
 * Pairs each element's tokens with its `data-testid` (the stable anchor for
 * per-element containment assertions). Only elements carrying ≥1 utility
 * token are returned.
 */
export function extractElementClasses(source: string): ElementClassFacts[] {
  const facts: ElementClassFacts[] = [];
  // Iterate JSX opening tags (and self-closing). Attr blob is captured
  // non-greedily up to the tag close.
  for (const m of source.matchAll(/<[A-Za-z][\w.]*\b([^>]*?)\/?>/g)) {
    const attrs = m[1] ?? "";
    const className = literalClassName(attrs);
    if (className === null) continue; // dynamic/module/no className → skip
    const tokens = className
      .split(/\s+/)
      .map((t) => t.trim())
      .filter((t) => isUtilityShaped(t));
    if (tokens.length === 0) continue;
    const tidMatch = attrs.match(/data-testid\s*=\s*["']([^"']+)["']/);
    facts.push({
      testid: tidMatch?.[1] ?? null,
      tokens: [...new Set(tokens)],
    });
  }
  return facts;
}

/**
 * Return the string-literal value of a `className` attribute from a tag's
 * attr blob, or null when the className is absent or a brace expression
 * (`className={...}` — dynamic/module/computed; intentionally not read).
 * Plain backtick literals are read only when they contain no `${}`.
 */
function literalClassName(attrs: string): string | null {
  const dq = attrs.match(/className\s*=\s*"([^"]*)"/);
  if (dq) return dq[1] ?? "";
  const sq = attrs.match(/className\s*=\s*'([^']*)'/);
  if (sq) return sq[1] ?? "";
  const bt = attrs.match(/className\s*=\s*`([^`]*)`/);
  if (bt && !bt[1]?.includes("${")) return bt[1] ?? "";
  return null;
}

/**
 * Heuristic: is `t` a utility-class token (Tailwind-shaped) rather than a
 * component/module identifier? Keeps lowercase-led tokens + any token with
 * a utility marker (`-`, `:`, `[`); drops capitalised identifiers and the
 * empty string. Errs permissive — string-literal classNames in a utility
 * mock are virtually all utilities.
 */
export function isUtilityShaped(t: string): boolean {
  if (!t) return false;
  if (/[-:[]/.test(t)) return true; // bg-primary, hover:..., min-h-[44px]
  return /^[a-z][a-z0-9]*$/.test(t); // flex, grid, block, hidden, relative
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
  /**
   * 0.19.0-alpha.6 (#75) — emit mode.
   *   "v1": source-grep tests (asserts text in brewed src/). Cheap,
   *     no render, but fragile (passes when testid is in a comment;
   *     misses dynamic className composition).
   *   "v2": render-and-assert tests. Imports the component, mounts
   *     via @testing-library/react, queries the live DOM. Catches
   *     drift v1 misses; requires components to render with default
   *     props (or skips downstream assertions cleanly).
   * Default: v1. Callers opt into v2 via --shape-mode v2.
   */
  emitMode?: "v1" | "v2";
}

/**
 * 0.19.0-alpha.6 — convert a `src/<rel>.tsx` source path to its
 * `@/<rel>` tsconfig-alias import specifier (drops the `.tsx`
 * extension; keeps directory structure). Pure: no IO.
 *
 * Examples:
 *   src/components/members/MemberReactionsPage.tsx
 *     → @/components/members/MemberReactionsPage
 *   src/lib/foo.ts
 *     → @/lib/foo
 *   mock/src/components/X.tsx (already mock-ish)
 *     → @/components/X (caller should pass mockToSrcPath first)
 */
export function srcPathToAliasImport(srcPath: string): string {
  const stripped = srcPath.replace(/^(?:mock\/)?src\//, "@/").replace(/\.(tsx?|jsx?)$/, "");
  return stripped;
}

export function synthesiseShapeTestFile(opts: SynthOpts): string {
  if (opts.emitMode === "v2") {
    return synthesiseShapeTestFileV2(opts);
  }
  return synthesiseShapeTestFileV1(opts);
}

/**
 * 0.19.0-alpha.6 (#75) — v2: render-and-assert structural tests.
 *
 * For each mock file, emit a test that:
 *   1. Imports the brewed src/ component via the @/ alias.
 *   2. Renders it with default props (`<Component />`) using
 *      @testing-library/react.
 *   3. Queries the live DOM for testid presence, className tokens
 *      on the rendered output, and <header> landmark presence.
 *
 * Keeps v1's "no inline hex" anti-wiring assertion (still source-
 * grep, cheap, catches token-family drift). The render assertions
 * are the v2 win — catches dynamic-className drift v1 missed.
 *
 * Defensive: every assertion wraps render in a top-level
 * "renders with default props" test. If that fails (component
 * needs real props), the downstream tests fail too — clean signal
 * that recon needs scenario-derived prop synthesis (a future α).
 */
export function synthesiseShapeTestFileV2(opts: SynthOpts): string {
  const { story, shapes } = opts;
  const lines: string[] = [];
  lines.push("// @vitest-environment jsdom");
  lines.push("//");
  lines.push(`// AUTO-GENERATED by slowcook recon --shape-mode v2 (story-${story}). Do not edit by hand.`);
  lines.push("// Renders each component + queries the live DOM. v2 catches dynamic-className");
  lines.push("// drift that v1's source-grep tests miss.");
  lines.push("//");
  lines.push("// Re-running recon regenerates this file.");
  lines.push("");
  lines.push(`import { describe, it, expect, afterEach } from "vitest";`);
  lines.push(`import { render, cleanup } from "@testing-library/react";`);
  // Import each component once at top of file so the test runner can
  // resolve them at module-eval time (same shape as production tests).
  for (const shape of shapes) {
    if (!shape.componentName) continue;
    const alias = srcPathToAliasImport(mockToSrcPath(shape.file));
    // Default-imports for default-exported components, named imports otherwise.
    // Best-effort detection: the source's "export default function" form
    // implies default. Fall back to default import (most common shape).
    lines.push(`import ${shape.componentName} from "${alias}";`);
  }
  lines.push("");
  lines.push(`describe("story-${story} structural shape v2 (recon-emitted)", () => {`);
  lines.push(`  afterEach(() => { cleanup(); });`);
  lines.push(``);

  if (shapes.every((s) => s.testids.length === 0 && s.visualTokens.length === 0 && !s.hasHeader)) {
    lines.push(`  it.skip("no testids/tokens/header found in mock UI — nothing to assert", () => {});`);
  } else {
    for (const shape of shapes) {
      if (!shape.componentName) continue;
      const cn = shape.componentName;
      lines.push(`  describe("<${cn} /> from ${shape.file}", () => {`);
      // Sentinel: can the component render with default props at all?
      lines.push(`    it("renders with default props (no throw)", () => {`);
      lines.push(`      expect(() => render(<${cn} />)).not.toThrow();`);
      lines.push(`    });`);
      // Per-testid render assertions
      for (const tid of shape.testids) {
        lines.push(`    it("DOM contains data-testid='${tid}'", () => {`);
        lines.push(`      const { queryByTestId } = render(<${cn} />);`);
        lines.push(`      expect(queryByTestId(${JSON.stringify(tid)})).toBeTruthy();`);
        lines.push(`    });`);
      }
      // Per-token render assertions: search the rendered DOM tree
      for (const token of shape.visualTokens) {
        lines.push(`    it("rendered DOM has class token '${token}'", () => {`);
        lines.push(`      const { container } = render(<${cn} />);`);
        lines.push(`      const found = container.querySelector('[class*="${token}"]');`);
        lines.push(`      expect(found, ${JSON.stringify(`expected at least one element with class token '${token}'`)}).toBeTruthy();`);
        lines.push(`    });`);
      }
      // Header semantic landmark
      if (shape.hasHeader) {
        lines.push(`    it("rendered DOM contains a <header> element", () => {`);
        lines.push(`      const { container } = render(<${cn} />);`);
        lines.push(`      expect(container.querySelector("header")).toBeTruthy();`);
        lines.push(`    });`);
      }
      // design #10 — per-element class containment (brewed ⊇ mock), anchored
      // by testid. Asserts the rendered element keeps the mock's utility-class
      // set; brew may ADD real-data classes (containment, not equality) but
      // not DROP the mock's styling.
      for (const ec of shape.elementClasses ?? []) {
        if (!ec.testid || ec.tokens.length === 0) continue;
        lines.push(`    it("[data-testid=${ec.testid}] keeps mock class tokens", () => {`);
        lines.push(`      const { queryByTestId } = render(<${cn} />);`);
        lines.push(`      const el = queryByTestId(${JSON.stringify(ec.testid)});`);
        lines.push(
          `      expect(el, ${JSON.stringify(`expected [data-testid=${ec.testid}] in rendered <${cn} />`)}).toBeTruthy();`,
        );
        lines.push(`      const have = (el?.getAttribute("class") ?? "").split(/\\s+/);`);
        lines.push(`      const missing = ${JSON.stringify(ec.tokens)}.filter((t) => !have.includes(t));`);
        lines.push(`      expect(missing, "dropped mock class tokens").toEqual([]);`);
        lines.push(`    });`);
      }
      // design #10 — no-testid dense coverage: tokens on unanchored elements
      // can't be matched per-element, so assert each survives SOMEWHERE in the
      // rendered tree (file-level containment via [class*=]). Excludes tokens
      // already covered by a testid-anchored or visualToken assertion.
      const anchoredV2 = new Set((shape.elementClasses ?? []).filter((e) => e.testid).flatMap((e) => e.tokens));
      const noTestidTokens = [
        ...new Set(
          (shape.elementClasses ?? [])
            .filter((e) => !e.testid)
            .flatMap((e) => e.tokens)
            .filter((t) => !anchoredV2.has(t) && !shape.visualTokens.includes(t)),
        ),
      ];
      for (const token of noTestidTokens) {
        lines.push(`    it("rendered DOM keeps mock class token '${token}'", () => {`);
        lines.push(`      const { container } = render(<${cn} />);`);
        lines.push(`      expect(container.querySelector('[class*="${token}"]')).toBeTruthy();`);
        lines.push(`    });`);
      }
      lines.push(`  });`);
      lines.push(``);
    }
    // Anti-wiring: source-grep "no inline hex" — kept from v1 for
    // token-family preservation. Cheap + complementary to the render
    // assertions (catches different drift class).
    lines.push(`  describe("token-family preservation (source-grep)", () => {`);
    lines.push(`    const { readFileSync, existsSync } = require("node:fs");`);
    for (const shape of shapes) {
      const srcPath = mockToSrcPath(shape.file);
      lines.push(`    it("${shape.componentName ?? shape.file}: no inline hex/rgb in className/style", () => {`);
      lines.push(`      const src = existsSync(${JSON.stringify(srcPath)}) ? readFileSync(${JSON.stringify(srcPath)}, "utf8") : "";`);
      lines.push(`      const styled = src.match(/(?:className|style)\\s*=\\s*["\`'][^"\`']*?[#][0-9a-fA-F]{3,8}[^"\`']*?["\`']/g) || [];`);
      lines.push(`      expect(styled, "no inline hex in className/style").toEqual([]);`);
      lines.push(`    });`);
    }
    lines.push(`  });`);
  }
  lines.push(`});`);
  return lines.join("\n") + "\n";
}

function synthesiseShapeTestFileV1(opts: SynthOpts): string {
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
      // design #10 — dense token containment (file-level, source-grep).
      // Coarse vs v2's per-element render assertion, but robust to bracket/
      // colon/slash tokens; ensures the mock's full utility set survives brew.
      const denseTokens = [...new Set((shape.elementClasses ?? []).flatMap((e) => e.tokens))].filter(
        (t) => !shape.visualTokens.includes(t),
      );
      for (const token of denseTokens) {
        lines.push(`    it("preserves mock class token '${token}'", () => {`);
        lines.push(`      expect(src).toContain(${JSON.stringify(token)});`);
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
