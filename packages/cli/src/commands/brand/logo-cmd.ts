/**
 * GUCDI — `slowcook brand logo`. Turns a supplied logo into a tokenized SVG for
 * the design system. SVG → passthrough; PNG → deterministic trace (vtracer/
 * potrace — an LLM NEVER authors paths, fixing the iterate-on-SVG pain) → then
 * tokenize fills to design-token CSS-vars so it recolors with the brand and
 * flips dark/light. Pure tokenizer in ./logo.ts; this is the tracer + IO shell.
 *
 *   slowcook brand logo --in <logo.svg|logo.png> [--out <dir>] [--cwd <dir>] [--map #hex=token,...]
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tokenizeSvg, untokenizedColors } from "./logo.js";

function val(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

function parseMap(s: string | undefined): Record<string, string> {
  const m: Record<string, string> = {};
  if (!s) return m;
  for (const pair of s.split(",")) {
    const [k, v] = pair.split("=");
    if (k && v) m[k.trim()] = v.trim();
  }
  return m;
}

/** Deterministic PNG→SVG. vtracer (color) preferred, potrace (mono) fallback. */
function traceToSvg(pngAbs: string): string {
  const attempts: [string, string[]][] = [
    ["vtracer", ["--input", pngAbs, "--output", "/dev/stdout"]],
    ["potrace", ["--svg", "-o", "-", pngAbs]],
  ];
  for (const [bin, args] of attempts) {
    try {
      return execFileSync(bin, args, { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
    } catch (e) {
      if ((e as { code?: string }).code !== "ENOENT") throw e;
    }
  }
  throw new Error("no tracer found — install vtracer (`cargo install vtracer`) or potrace, or supply an .svg with --in");
}

export async function brandLogo(argv: string[]): Promise<void> {
  const cwd = resolve(val(argv, "--cwd") ?? ".");
  const inFile = val(argv, "--in");
  if (!inFile) {
    console.error("usage: slowcook brand logo --in <logo.svg|logo.png> [--out <dir>] [--map #hex=token,...]");
    process.exit(64);
  }
  const inAbs = resolve(cwd, inFile);
  if (!existsSync(inAbs)) {
    console.error(`brand logo: input not found: ${inFile}`);
    process.exit(64);
  }
  const outDir = resolve(cwd, val(argv, "--out") ?? join("mock", "src", "design-system"));
  mkdirSync(outDir, { recursive: true });

  let svg: string;
  if (inFile.toLowerCase().endsWith(".svg")) {
    svg = readFileSync(inAbs, "utf8");
  } else {
    console.log(`brand logo: tracing ${inFile} → SVG (deterministic; no LLM) ...`);
    try {
      svg = traceToSvg(inAbs);
    } catch (e) {
      console.error(`brand logo: ${String(e instanceof Error ? e.message : e)}`);
      process.exit(69);
    }
  }

  const map = parseMap(val(argv, "--map"));
  const tokenized = tokenizeSvg(svg, map);
  const outPath = join(outDir, "logo.svg");
  writeFileSync(outPath, tokenized);
  console.log(`brand logo: wrote ${outPath}`);

  const remaining = untokenizedColors(tokenized, map);
  if (remaining.length) {
    console.log(`  ${remaining.length} color(s) still hardcoded — map them with --map (#hex=token):`);
    for (const c of remaining) console.log(`    ${c}=<token>`);
  } else if (Object.keys(map).length) {
    console.log("  all colors tokenized → recolors with the brand + flips dark/light via CSS vars.");
  }
  console.log("  tip: render it + `slowcook eye` against the source to verify trace fidelity.");
}
