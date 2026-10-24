/**
 * WP2 (2026-10-24) — which PR-head files taste reads as "the present".
 *
 * Until now taste kept only tests/, supabase/tests/, specs/ and the
 * manifest (max 8), while its own prompt promised a "tests must match
 * shipped signatures" check against the head files. With no src file in
 * context that check had nothing to compare and the reviewer guessed.
 *
 * Pure: the ranking takes the changed paths plus the contents of the kept
 * test files and returns an ordered list. Contract files first (unchanged
 * behaviour), then src files a kept test imports, then the other src files
 * the PR touched. Capped at `cap` (12) so the 12k-per-file slice stays
 * inside the prompt budget.
 */

export const CONTRACT_PREFIXES = ["tests/", "supabase/tests/", "specs/", ".brewing/manifests/"];
const SOURCE_PREFIXES = ["src/", "app/", "lib/", "components/", "server/", "supabase/functions/"];
export const HEAD_FILE_CAP = 12;
const CONTRACT_CAP = 8;

export function isContractPath(p: string): boolean {
  return CONTRACT_PREFIXES.some((pre) => p.startsWith(pre));
}

export function isSourcePath(p: string): boolean {
  if (isContractPath(p)) return false;
  if (/\.(test|spec)\.[cm]?[jt]sx?$/.test(p)) return false;
  return SOURCE_PREFIXES.some((pre) => p.startsWith(pre)) || p.includes("/src/");
}

/** Import specifiers of a TS/JS module: `import … from "x"`, `import("x")`, `require("x")`. */
export function importSpecifiers(source: string): string[] {
  const out: string[] = [];
  const re = /(?:^|\n)\s*import\s+(?:[^'"]*?\s+from\s+)?['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)|require\(\s*['"]([^'"]+)['"]\s*\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) {
    const spec = m[1] ?? m[2] ?? m[3];
    if (spec) out.push(spec);
  }
  return out;
}

/**
 * Does `srcPath` satisfy the import `spec` written in `fromFile`?
 * Handles `@/x` → `src/x`, relative paths, dropped extensions and
 * `/index` files. A bare package name never matches a repo file.
 */
export function importResolvesTo(spec: string, fromFile: string, srcPath: string): boolean {
  let target: string | null = null;
  if (spec.startsWith("@/")) target = "src/" + spec.slice(2);
  else if (spec.startsWith("~/")) target = "src/" + spec.slice(2);
  else if (spec.startsWith("./") || spec.startsWith("../")) {
    const dir = fromFile.split("/").slice(0, -1);
    for (const seg of spec.split("/")) {
      if (seg === "." || seg === "") continue;
      if (seg === "..") dir.pop();
      else dir.push(seg);
    }
    target = dir.join("/");
  }
  if (!target) return false;
  const stripped = srcPath.replace(/\.[cm]?[jt]sx?$/, "");
  const t = target.replace(/\.[cm]?[jt]sx?$/, "");
  return stripped === t || stripped === `${t}/index`;
}

export interface RankedHeadFiles {
  /** Ordered paths to read at the PR head. */
  paths: string[];
  /** Subset of `paths` that are src files (for prompt labelling). */
  sourcePaths: Set<string>;
}

/**
 * Order the PR's changed files for the head-file read. `testContents`
 * carries the contents of kept test files (path → source) so src files a
 * test imports rank ahead of src files it does not.
 */
export function rankHeadFiles(
  changed: string[],
  testContents: ReadonlyMap<string, string>,
  cap: number = HEAD_FILE_CAP
): RankedHeadFiles {
  const contract = changed.filter(isContractPath).slice(0, CONTRACT_CAP);
  const sources = changed.filter(isSourcePath);
  const imports: Array<{ file: string; spec: string }> = [];
  for (const [file, src] of testContents) {
    for (const spec of importSpecifiers(src)) imports.push({ file, spec });
  }
  const referenced = sources.filter((s) => imports.some((i) => importResolvesTo(i.spec, i.file, s)));
  const rest = sources.filter((s) => !referenced.includes(s));
  const paths = [...contract, ...referenced, ...rest].slice(0, cap);
  return { paths, sourcePaths: new Set(paths.filter((p) => isSourcePath(p))) };
}
