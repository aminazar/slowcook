/**
 * GUCDI — `slowcook greenfield status`. The scope-completeness dashboard: where
 * the project is in PRD → stories → brand → LCR → trace, and the single next
 * action. Makes the step-by-step greenfield flow navigable (the individual
 * agents — menu/brand/vibe/eye/trace — already exist).
 *
 *   slowcook greenfield status [--prd <path>] [--cwd <dir>]
 *
 * Pure planner in ./status.ts; this is the IO shell.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { listActiveSpecs } from "../refine/spec-yaml.js";
import { loadMockShapeConfig } from "../../lib/mock-shape.js";
import { parsePrdInitiatives } from "../menu/prd.js";
import { checkTrace, parseLcrProvenance, type LcrNode, type SpecNode } from "../trace/check.js";
import { computeGreenfieldStatus, type GreenfieldSpecFact } from "./status.js";

function val(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

function walkTsx(dir: string, exclude: Set<string>): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (exclude.has(p) || name === "node_modules") continue;
    const st = statSync(p);
    if (st.isDirectory()) out.push(...walkTsx(p, exclude));
    else if (name.endsWith(".tsx")) out.push(p);
  }
  return out;
}

export async function greenfield(argv: string[], _cliVersion: string): Promise<void> {
  if (argv[0] !== "status") {
    console.error("usage: slowcook greenfield status [--prd <path>] [--cwd <dir>]");
    process.exit(64);
  }
  const rest = argv.slice(1);
  const cwd = resolve(val(rest, "--cwd") ?? ".");

  const specs = listActiveSpecs(cwd);

  const prdRel = val(rest, "--prd") ?? "docs/PRD.md";
  const prdAbs = resolve(cwd, prdRel);
  const prdInitiatives = existsSync(prdAbs) ? parsePrdInitiatives(readFileSync(prdAbs, "utf8")) : [];

  const mock = loadMockShapeConfig(cwd);
  const designDir = resolve(cwd, mock.design_system_dir);
  const lcrRoots = [resolve(cwd, mock.screens_root), resolve(cwd, mock.mock_root, "src/components")];
  const files = [...new Set(lcrRoots.flatMap((r) => walkTsx(r, new Set([designDir]))))];
  const lcrNodes: LcrNode[] = files.map((f) => ({
    file: relative(cwd, f).replace(/\\/g, "/"),
    provenance: parseLcrProvenance(readFileSync(f, "utf8")),
  }));
  const referenced = new Set(
    lcrNodes.flatMap((n) => n.provenance.filter((p): p is { kind: "story"; id: string } => p.kind === "story").map((p) => p.id)),
  );

  const brandPresent = existsSync(resolve(cwd, mock.design_system_dir, "tokens.ts"));

  const specNodes: SpecNode[] = specs.map((s) => ({ storyId: s.story_id, prdAnchor: s.prd_ref?.anchor, sourceIssue: s.source_issue }));
  const traceViolations = checkTrace({ specs: specNodes, prdAnchors: prdInitiatives.map((i) => i.anchor), lcrNodes }).violations.length;

  const specFacts: GreenfieldSpecFact[] = specs.map((s) => ({
    storyId: s.story_id,
    anchored: Boolean(s.prd_ref?.anchor || s.source_issue),
    addressableQuestions: s.open_questions?.addressable?.length ?? 0,
    hasLcr: referenced.has(`story-${s.story_id}`),
  }));

  const status = computeGreenfieldStatus({
    prdInitiatives: prdInitiatives.length,
    specs: specFacts,
    brandPresent,
    traceViolations,
  });

  console.log("slowcook greenfield — scope status\n");
  for (const st of status.stages) {
    console.log(`  ${st.done ? "✓" : "·"} ${st.name.padEnd(18)} ${st.detail}`);
  }
  console.log(`\n  scope-complete: ${status.scopeComplete ? "YES ✓" : "not yet"}`);
  console.log(`  next: ${status.nextAction}`);
}
