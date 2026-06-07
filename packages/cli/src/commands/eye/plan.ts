/**
 * design #8 — `slowcook eye` planning (pure). Expands the CLI flags into the
 * (viewport × scheme) capture matrix + gate thresholds the runner executes.
 * Kept pure + unit-tested; the Playwright execution lives in ./index.ts.
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

function val(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

/**
 * Parse `slowcook eye` flags. Required: --reference <url>, --candidate <url>.
 * Optional: --out <dir> (default ./.brewing/eye), --viewport <name> + --scheme
 * <light|dark> to narrow the matrix, --max-violations <n>, --fail-on <a,b>.
 * Throws on a missing required flag (caller maps to a non-zero exit).
 */
export function parseEyeArgs(args: string[]): EyeOptions {
  const referenceUrl = val(args, "--reference");
  const candidateUrl = val(args, "--candidate");
  if (!referenceUrl || !candidateUrl) {
    throw new Error("eye: --reference <url> and --candidate <url> are both required");
  }

  let matrix = DEFAULT_MATRIX;
  const onlyViewport = val(args, "--viewport");
  const onlyScheme = val(args, "--scheme");
  if (onlyViewport) {
    if (!VIEWPORTS[onlyViewport]) throw new Error(`eye: unknown --viewport '${onlyViewport}' (have: ${Object.keys(VIEWPORTS).join(", ")})`);
    matrix = matrix.filter((c) => c.viewport === onlyViewport);
  }
  if (onlyScheme) {
    if (onlyScheme !== "light" && onlyScheme !== "dark") throw new Error(`eye: --scheme must be light|dark`);
    matrix = matrix.filter((c) => c.scheme === onlyScheme);
  }

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
  };
}
