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
  /**
   * design §6 — locale/direction axis. When set, the runner drives the
   * consumer's language by appending `?lang=<locale>` to BOTH the reference
   * and the candidate URL (RTL/LTR layouts drift independently). Absent on
   * the default matrix → unchanged viewport×scheme behaviour.
   */
  locale?: string;
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
  /**
   * design §6 — locale codes from `--locale fa,en`. Applied as a third matrix
   * axis (driven via `?lang=` on both sides). When the spec/CLI declares none,
   * the matrix has no locale dimension and behaviour is unchanged.
   */
  locales?: string[];
  /**
   * design §4 — shared-fixture scenario from `--scenario <name>`. Appended as
   * `?scenario=<name>` to BOTH sides so the mock's mock-data layer and the
   * candidate's dev-only data adaptor render the SAME fixture → 1-1 diff.
   */
  scenario?: string;
  /** design #8 / sc#189 — warm-browser HMR re-eye loop. */
  watch: boolean;
  /** Poll interval between watch passes (ms). Default 2000. */
  intervalMs: number;
  /** In watch mode, exit 0 as soon as the gate passes. */
  untilConverged: boolean;
  /** Safety cap on watch passes. Default 60. */
  maxPasses: number;
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
 * design §6 — extract locale codes from `fidelity.modes`. Locales are namespaced
 * tokens (`locale:fa`, `locale:en`) so they never collide with viewport/scheme
 * values and a typo stays ignored (fail-open). Returns [] when none declared.
 */
export function localesFromModes(modes: string[]): string[] {
  return modes
    .map((m) => String(m).toLowerCase().trim())
    .filter((m) => m.startsWith("locale:"))
    .map((m) => m.slice("locale:".length))
    .filter(Boolean);
}

/**
 * Add (or filter) the locale axis on a matrix (pure). If the matrix already
 * carries a locale dimension, narrow it to `locales`; otherwise multiply each
 * cell by the locales (CLI/spec opting the axis in). No-op when `locales` empty.
 */
export function applyLocaleAxis(matrix: EyeContext[], locales: string[] | undefined): EyeContext[] {
  if (!locales || !locales.length) return matrix;
  const set = new Set(locales);
  if (matrix.some((c) => c.locale != null)) {
    return matrix.filter((c) => c.locale != null && set.has(c.locale));
  }
  return matrix.flatMap((c) => locales.map((locale) => ({ ...c, locale })));
}

/**
 * Build the capture matrix from a spec's declared `fidelity.modes` (pure).
 * Tokens are dimension VALUES (`light`/`dark`/`mobile`/`desktop`, plus
 * `locale:<code>` for the §6 locale axis), expanded to the product: a dimension
 * with no declared value defaults to its full set (so `[dark]` → dark ×
 * {mobile,desktop}; `[mobile]` → {light,dark} × mobile). Locale is OPTIONAL — no
 * `locale:` token means no locale dimension. Unrecognised tokens are ignored; if
 * NONE are recognised, the full default matrix is returned (fail-open — a typo
 * never silently checks nothing).
 */
export function matrixFromModes(modes: string[]): EyeContext[] {
  const wanted = new Set(modes.map((m) => String(m).toLowerCase().trim()));
  const viewports = Object.keys(VIEWPORTS).filter((v) => wanted.has(v));
  const schemes = SCHEMES.filter((s) => wanted.has(s));
  const locales = localesFromModes(modes);
  if (!viewports.length && !schemes.length && !locales.length) return DEFAULT_MATRIX;
  const vps = viewports.length ? viewports : Object.keys(VIEWPORTS);
  const schs = schemes.length ? schemes : SCHEMES;
  const base = vps.flatMap((viewport) => schs.map((scheme) => ({ viewport, scheme, ...VIEWPORTS[viewport]! })));
  return applyLocaleAxis(base, locales);
}

/** Narrow a matrix by explicit --viewport / --scheme / --locale flags (pure). Validates. */
export function narrowMatrix(
  base: EyeContext[],
  opts: { viewport?: string; scheme?: string; locales?: string[] },
): EyeContext[] {
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
  // Locale flags can only NARROW a spec-declared locale axis here; when the base
  // has no locale dimension, applyLocaleAxis (in parseEyeArgs/index) opts it in.
  if (opts.locales && opts.locales.length && m.some((c) => c.locale != null)) {
    m = applyLocaleAxis(m, opts.locales);
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
 * --locale <fa,en> (§6 locale axis), --scenario <name> (§4 shared fixture),
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
  const localeArg = val(args, "--locale");
  const locales = localeArg
    ? localeArg.split(",").map((s) => s.trim()).filter(Boolean)
    : undefined;
  // CLI default matrix has no locale dimension → applyLocaleAxis multiplies it in.
  const matrix = applyLocaleAxis(narrowMatrix(DEFAULT_MATRIX, { viewport, scheme }), locales);

  const maxV = val(args, "--max-violations");
  const failOn = val(args, "--fail-on");
  const gate: FidelityGateOptions = {};
  if (maxV !== undefined) gate.maxViolations = Number.parseInt(maxV, 10);
  if (failOn) gate.failOnAxes = failOn.split(",").map((s) => s.trim()) as FidelityAxis[];

  const interval = val(args, "--interval");
  const maxPasses = val(args, "--max-passes");

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
    locales,
    scenario: val(args, "--scenario"),
    watch: args.includes("--watch"),
    intervalMs: interval !== undefined ? Number.parseInt(interval, 10) : 2000,
    untilConverged: args.includes("--until-converged"),
    maxPasses: maxPasses !== undefined ? Number.parseInt(maxPasses, 10) : 60,
  };
}
