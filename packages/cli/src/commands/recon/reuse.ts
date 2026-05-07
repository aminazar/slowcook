/**
 * 0.19.0-alpha.8 — recon reuse-scan: deterministic near-duplicate
 * detection for components AND API routes / utility modules. Pure
 * functions for testing; cli wiring in `recon/index.ts`'s
 * --reuse-scan flag.
 *
 * Why this exists: when driver creates `NewItemCard` that's near-
 * identical to existing `RewoCard` — OR when two API routes both
 * do auth → query → NextResponse.json with similar shapes —
 * navigator can't catch it (its prompt is calibrated for diff-
 * level critique, not codebase-scale similarity). A static AST-ish
 * hash + Jaccard similarity catches it cheaply + deterministically.
 * False positives are acceptable because the refactor command's
 * ranking + the PM's eyeball filter the noise.
 *
 * Approach: regex-extract a "structural signature" (JSX tags,
 * destructured params, calls, exports, imports). Auto-categorize
 * by JSX presence: component-vs-component uses jsx-heavy weighting,
 * api-vs-api uses calls-heavy, cross-category pairs short-circuit
 * to 0 (we don't compare a component against a route handler).
 */

export interface ScanSignature {
  /** Repo-relative path. */
  path: string;
  /** Identifiers exported from the file (default + named). */
  exports: string[];
  /** Identifiers imported (across all import statements). */
  imports: string[];
  /** Distinct JSX element types (`<div>`, `<Foo>`). Empty for API/utility files. */
  jsxTags: string[];
  /** Params destructured from the function arg (`{ a, b }: Props`,
   *  or `({ id }: { id: string })`). */
  propsUsed: string[];
  /** Function calls (e.g. `useState`, `supabase.from`, `NextResponse.json`,
   *  `fetch`). Broader than just React hooks — captures the structural
   *  fingerprint of API + utility modules too. */
  callsUsed: string[];
}

/**
 * Extract a structural signature from a TS/TSX file's source.
 * Pure: takes (path, source); returns a normalized signature.
 *
 * Works for components (JSX tags will be populated), API route
 * handlers (callsUsed captures supabase/auth/NextResponse), and
 * utility modules (callsUsed + exports). Strings + comments are
 * NOT stripped — false positives are rare for the categories we
 * capture.
 */
export function extractStructuralSignature(path: string, source: string): ScanSignature {
  const exports = new Set<string>();
  const imports = new Set<string>();
  const jsxTags = new Set<string>();
  const propsUsed = new Set<string>();
  const callsUsed = new Set<string>();

  // Exports: `export default function Foo`, `export function Foo`,
  // `export const Foo`, `export async function GET`,
  // `export { Foo, Bar as Baz }`.
  for (const m of source.matchAll(/export\s+default\s+function\s+([A-Za-z_]\w*)/g)) exports.add(m[1]!);
  for (const m of source.matchAll(/export\s+(?:async\s+)?function\s+([A-Za-z_]\w*)/g)) exports.add(m[1]!);
  for (const m of source.matchAll(/export\s+const\s+([A-Za-z_]\w*)/g)) exports.add(m[1]!);
  for (const m of source.matchAll(/export\s*\{\s*([^}]+)\s*\}/g)) {
    for (const piece of m[1]!.split(",")) {
      const name = piece.trim().split(/\s+as\s+/)[0]!.trim();
      if (name) exports.add(name);
    }
  }

  // Imports: `import X from "..."`, `import { A, B } from "..."`,
  // `import X, { A } from "..."`. Skip the source path; we want
  // the symbols.
  const importRe = /import\s+(?:type\s+)?(?:([A-Za-z_]\w*)(?:\s*,\s*\{([^}]*)\})?|\{([^}]*)\})\s+from\s+["'][^"']+["']/g;
  for (const m of source.matchAll(importRe)) {
    if (m[1]) imports.add(m[1]);
    const named = m[2] ?? m[3];
    if (named) {
      for (const piece of named.split(",")) {
        const name = piece.trim().split(/\s+as\s+/)[0]!.trim();
        if (name) imports.add(name);
      }
    }
  }

  // JSX tags: <Foo> or <Foo />. Captures only the opening tag form;
  // self-closing covered by /> alternation.
  for (const m of source.matchAll(/<([A-Za-z][\w.]*)[\s/>]/g)) {
    jsxTags.add(m[1]!);
  }

  // Destructured params: `function Foo({ a, b, c }: Props)` —
  // works for components (Props) AND API handlers
  // (`async function GET(req: NextRequest, { params }: { params: ... })`).
  for (const m of source.matchAll(/function\s+[A-Za-z_]\w*\s*\(\s*\{([^}]+)\}\s*[:)]/g)) {
    for (const piece of m[1]!.split(",")) {
      const name = piece.trim().split(":")[0]!.trim().split("=")[0]!.trim();
      if (name && /^[A-Za-z_]\w*$/.test(name)) propsUsed.add(name);
    }
  }
  // Arrow function destructure: ({ a, b }) => OR ({ a, b }: { a: T }) =>
  // Type annotation can be ANY shape (alias, inline object, union); we just
  // need to land on `=>` after the destructure body. `[^=]*=>` skips
  // arbitrary annotation text up to the arrow.
  for (const m of source.matchAll(/\(\s*\{([^}]+)\}[^=]*=>/g)) {
    for (const piece of m[1]!.split(",")) {
      const name = piece.trim().split(":")[0]!.trim().split("=")[0]!.trim();
      if (name && /^[A-Za-z_]\w*$/.test(name)) propsUsed.add(name);
    }
  }
  // Second-arg destructure used by Next.js route handlers:
  //   export async function GET(req: Request, { params }: { params: ... })
  for (const m of source.matchAll(/,\s*\{([^}]+)\}\s*:\s*\{[^}]*\}/g)) {
    for (const piece of m[1]!.split(",")) {
      const name = piece.trim().split(":")[0]!.trim().split("=")[0]!.trim();
      if (name && /^[A-Za-z_]\w*$/.test(name)) propsUsed.add(name);
    }
  }

  // Function calls: anything that looks like `<name>(`,
  // `<obj>.<method>(`, or `<obj>.<method>.<chain>(`. Captures hooks
  // (useState, useFoo), db ops (supabase.from), fetch, auth helpers,
  // NextResponse.json, etc. — the structural fingerprint of a file
  // when you ignore its strings + JSX.
  //
  // Filter: skip primitives + control-flow keywords masquerading as
  // calls (`if(`, `for(`, `while(`). Skip lowercase one-letter
  // names (regex's true/false noise).
  const callRe = /\b([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*)\s*\(/g;
  const skip = new Set([
    "if", "for", "while", "switch", "catch", "return", "typeof", "await",
    "throw", "new", "yield", "delete", "void", "function", "async",
    "true", "false", "null", "undefined",
  ]);
  for (const m of source.matchAll(callRe)) {
    const name = m[1]!;
    // Skip the bare keywords; capture the full chain otherwise.
    if (skip.has(name)) continue;
    callsUsed.add(name);
  }

  // Filter call-name false positives: when a file declares X via
  // `export function X(...)` or `export const X = (...)`, the function
  // name itself looks like a call site to the bare-call regex. Remove
  // export names from callsUsed so a file's identity (its export name)
  // doesn't pollute its structural signature.
  for (const e of exports) callsUsed.delete(e);

  return {
    path,
    exports: [...exports].sort(),
    imports: [...imports].sort(),
    jsxTags: [...jsxTags].sort(),
    propsUsed: [...propsUsed].sort(),
    callsUsed: [...callsUsed].sort(),
  };
}

/**
 * Jaccard similarity of two string sets. Pure.
 *   |a ∩ b| / |a ∪ b|
 * Returns 1 if both sets empty (degenerate equal-empty case);
 * 0 if one is empty + the other isn't.
 */
export function jaccard(a: string[], b: string[]): number {
  if (a.length === 0 && b.length === 0) return 1;
  if (a.length === 0 || b.length === 0) return 0;
  const sa = new Set(a);
  const sb = new Set(b);
  let inter = 0;
  for (const x of sa) if (sb.has(x)) inter++;
  const union = sa.size + sb.size - inter;
  return inter / union;
}

/**
 * Compute similarity between two structural signatures. Auto-
 * categorizes by JSX presence:
 *
 *   component-vs-component (both have jsxTags):
 *     0.50 jsx + 0.30 props + 0.20 calls
 *
 *   api/utility-vs-api/utility (both jsxTags empty):
 *     0.60 calls + 0.30 props + 0.10 imports
 *
 *   cross-category (one has jsx, other doesn't):
 *     return 0 — comparing a component to a route handler is
 *     never a useful "duplicate" finding.
 *
 * Returns a number in [0, 1]. Default duplicate threshold: 0.7.
 */
export function signatureSimilarity(a: ScanSignature, b: ScanSignature): number {
  const aHasJsx = a.jsxTags.length > 0;
  const bHasJsx = b.jsxTags.length > 0;
  if (aHasJsx !== bHasJsx) return 0;
  if (aHasJsx && bHasJsx) {
    return (
      0.5 * jaccard(a.jsxTags, b.jsxTags) +
      0.3 * jaccard(a.propsUsed, b.propsUsed) +
      0.2 * jaccard(a.callsUsed, b.callsUsed)
    );
  }
  // API / utility comparison
  return (
    0.6 * jaccard(a.callsUsed, b.callsUsed) +
    0.3 * jaccard(a.propsUsed, b.propsUsed) +
    0.1 * jaccard(a.imports, b.imports)
  );
}

export interface DuplicatePair {
  a: string;
  b: string;
  similarity: number;
  /** Whether the pair is component-vs-component or api-vs-api. */
  category: "component" | "api-or-util";
  /** Per-axis breakdown for the operator. */
  axes: { jsx: number; props: number; calls: number; imports: number };
}

/**
 * Scan a list of structural signatures + return all pairs whose
 * similarity is >= threshold. Output is sorted by similarity
 * descending. Pure: caller owns IO (reading files into the
 * signatures array).
 */
export function scanForDuplicates(
  signatures: ScanSignature[],
  threshold = 0.7,
): DuplicatePair[] {
  const out: DuplicatePair[] = [];
  for (let i = 0; i < signatures.length; i++) {
    for (let j = i + 1; j < signatures.length; j++) {
      const a = signatures[i]!;
      const b = signatures[j]!;
      const sim = signatureSimilarity(a, b);
      if (sim >= threshold) {
        const category: "component" | "api-or-util" =
          a.jsxTags.length > 0 && b.jsxTags.length > 0 ? "component" : "api-or-util";
        out.push({
          a: a.path,
          b: b.path,
          similarity: sim,
          category,
          axes: {
            jsx: jaccard(a.jsxTags, b.jsxTags),
            props: jaccard(a.propsUsed, b.propsUsed),
            calls: jaccard(a.callsUsed, b.callsUsed),
            imports: jaccard(a.imports, b.imports),
          },
        });
      }
    }
  }
  out.sort((x, y) => y.similarity - x.similarity);
  return out;
}

/**
 * Convert a duplicate-pair finding into a refactor proposal that
 * the `slowcook refactor` command can rank. Pure synthesis — no IO.
 *
 * The proposal has:
 *   - id: deterministic from the pair (so re-running doesn't dup)
 *   - title: "consolidate <A> + <B> (NN% similar)" with the category
 *   - filesAffected: both paths
 *   - estimatedLocDelta: caller doesn't know, conservative 0
 *     (the proposal tells you to merge; the actual diff happens
 *     when someone DOES the work)
 *   - estimatedValueScore: scaled from similarity
 *     (similarity 0.7 → 5; 0.85 → 7; 0.95 → 9)
 */
export function pairToRefactorProposal(pair: DuplicatePair): {
  id: string;
  title: string;
  rationale: string;
  filesAffected: string[];
  estimatedLocDelta: number;
  estimatedValueScore: number;
  evidence: Record<string, string | number>;
} {
  const idSlug = [pair.a, pair.b]
    .sort()
    .map((p) => p.replace(/[^A-Za-z0-9]/g, "-"))
    .join("__");
  const id = `reuse-scan/${idSlug}`;
  const pct = Math.round(pair.similarity * 100);
  const score = Math.round(5 + (pair.similarity - 0.7) * (4 / 0.3)); // 0.7→5, 1.0→9
  const categoryLabel = pair.category === "component" ? "components" : "API/utility files";
  return {
    id,
    title: `consolidate ${pair.a} + ${pair.b} (${pct}% similar ${categoryLabel})`,
    rationale: `Recon's reuse scan flagged these two ${categoryLabel} as ${pct}% structurally similar. Likely candidate for extraction into a shared module or for one to be deleted in favor of the other. Per-axis: jsx=${pair.axes.jsx.toFixed(2)} props=${pair.axes.props.toFixed(2)} calls=${pair.axes.calls.toFixed(2)} imports=${pair.axes.imports.toFixed(2)}.`,
    filesAffected: [pair.a, pair.b],
    estimatedLocDelta: 0,
    estimatedValueScore: Math.max(1, Math.min(9, score)),
    evidence: {
      similarity: pair.similarity,
      category: pair.category,
      jsx_jaccard: pair.axes.jsx,
      props_jaccard: pair.axes.props,
      calls_jaccard: pair.axes.calls,
      imports_jaccard: pair.axes.imports,
    },
  };
}
