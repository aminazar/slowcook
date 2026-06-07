/**
 * design #8 — `slowcook eye` planning (pure). Expands the CLI flags + the
 * spec's declared fidelity modes into the (viewport × scheme) capture matrix +
 * gate thresholds the runner executes. Kept pure + unit-tested; the Playwright
 * execution + spec IO live in ./index.ts (matrix source) and ./spec-modes.ts.
 *
 * Which modes are in fidelity scope is a CONTRACT declared by refine in the
 * spec (`fidelity.modes`), not chosen by brew. The eye reads + enforces it;
 * brew is measured against it. CLI flags can only NARROW (never widen).
 */
import type { FidelityAxis, FidelityGateOptions } from "@slowcook-ai/gates";

/** A capture context plus the pixel viewport to emulate. */
export interface EyeContext {
  viewport: string;
  scheme: "light" | "dark";
  width: number;
  height: number;
}

export interface EyeOptions {
  referenceUrl: string;
  candidateUrl: string;
  outDir: string;
  matrix: EyeContext[];
  gate: FidelityGateOptions;
  /** When set, the runner derives the matrix from this story's `fidelity.modes`. */
  story?: string;
  /** Repo root for spec lookup (default "."). */
  cwd: string;
  /** Raw narrowing flags, re-applied after a spec-derived matrix is built. */
  viewport?: string;
  scheme?: string;
}

export const VIEWPORTS: Record<string, { width: number; height: number }> = {
  mobile: { width: 390, height: 844 },
  desktop: { width: 1280, height: 800 },
};

const SCHEMES: ReadonlyArray<"light" | "dark"> = ["light", "dark"];

/** Full default matrix: {mobile,desktop} × {light,dark}. */
export const DEFAULT_MATRIX: EyeContext[] = Object.entries(VIEWPORTS).flatMap(([viewport, dim]) =>
  SCHEMES.map((scheme) => ({ viewport, scheme, ...dim })),
);

/**
 * Build the capture matrix from a spec's declared `fidelity.modes` (pure).
 * Tokens are dimension VALUES (`light`/`dark`/`mobile`/`desktop`), expanded to
 * the product: a dimension with no declared value defaults to its full set
 * (so `[dark]` → dark × {mobile,desktop}; `[mobile]` → {light,dark} × mobile).
 * Unrecognised tokens are ignored; if NONE are recognised, the full default
 * matrix is returned (fail-open — a typo never silently checks nothing).
 */
export function matrixFromModes(modes: string[]): EyeContext[] {
  const wanted = new Set(modes.map((m) => String(m).toLowerCase().trim()));
  const viewports = Object.keys(VIEWPORTS).filter((v) => wanted.has(v));
  const schemes = SCHEMES.filter((s) => wanted.has(s));
  if (!viewports.length && !schemes.length) return DEFAULT_MATRIX;
  const vps = viewports.length ? viewports : Object.keys(VIEWPORTS);
  const schs = schemes.length ? schemes : SCHEMES;
  return vps.flatMap((viewport) => schs.map((scheme) => ({ viewport, scheme, ...VIEWPORTS[viewport]! })));
}

/** Narrow a matrix by explicit --viewport / --scheme flags (pure). Validates. */
export function narrowMatrix(base: EyeContext[], opts: { viewport?: string; scheme?: string }): EyeContext[] {
  let m = base;
  if (opts.viewport) {
    if (!VIEWPORTS[opts.viewport]) {
      throw new Error(`eye: unknown --viewport '${opts.viewport}' (have: ${Object.keys(VIEWPORTS).join(", ")})`);
    }
    m = m.filter((c) => c.viewport === opts.viewport);
  }
  if (opts.scheme) {
    if (opts.scheme !== "light" && opts.scheme !== "dark") throw new Error("eye: --scheme must be light|dark");
    m = m.filter((c) => c.scheme === opts.scheme);
  }
  return m;
}

function val(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

/**
 * Parse `slowcook eye` flags. Required: --reference <url>, --candidate <url>.
 * Optional: --story <id> (derive the matrix from the spec's fidelity.modes),
 * --cwd <dir>, --out <dir>, --viewport <name> + --scheme <light|dark> (narrow),
 * --max-violations <n>, --fail-on <a,b>. The returned `matrix` is the flag-only
 * default; when `story` is set the runner rebuilds it from the spec.
 */
export function parseEyeArgs(args: string[]): EyeOptions {
  const referenceUrl = val(args, "--reference");
  const candidateUrl = val(args, "--candidate");
  if (!referenceUrl || !candidateUrl) {
    throw new Error("eye: --reference <url> and --candidate <url> are both required");
  }

  const viewport = val(args, "--viewport");
  const scheme = val(args, "--scheme");
  const matrix = narrowMatrix(DEFAULT_MATRIX, { viewport, scheme });

  const maxV = val(args, "--max-violations");
  const failOn = val(args, "--fail-on");
  const gate: FidelityGateOptions = {};
  if (maxV !== undefined) gate.maxViolations = Number.parseInt(maxV, 10);
  if (failOn) gate.failOnAxes = failOn.split(",").map((s) => s.trim()) as FidelityAxis[];

  return {
    referenceUrl,
    candidateUrl,
    outDir: val(args, "--out") ?? ".brewing/eye",
    matrix,
    gate,
    story: val(args, "--story"),
    cwd: val(args, "--cwd") ?? ".",
    viewport,
    scheme,
  };
}
