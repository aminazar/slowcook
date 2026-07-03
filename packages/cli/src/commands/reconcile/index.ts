/**
 * `slowcook reconcile` — the LLM half of PRD↔spec interdependency. When `trace
 * impact` / `trace check` flags a spec as stale (its PRD section moved), reconcile
 * takes that one spec + the changed PRD section and PROPOSES a corrected spec —
 * the side-effects audit lifted from issue→test (refine) to PRD→spec.
 *
 *   slowcook reconcile --story 019 [--prd docs/PRD.md] [--apply] [--dry-run]
 *
 * Contract (docs/plans/prd-stories-interdependency.md):
 *   - PROPOSE, don't apply. Default writes `specs/story-<id>.reconcile.yaml`
 *     (a proposal) + prints the contradictions; `--apply` accepts it.
 *   - ONE HOP. Reconciles this spec against its PRD section only; cross-impact
 *     on the PRD / other stories is reported, never acted on.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import YAML from "yaml";
import { createLlmClient, RECONCILE_SYSTEM, formatCostFooter } from "@slowcook-ai/llm-anthropic";
import { listActiveSpecs, SPECS_DIR, schemas, normalizeScenarioArrays } from "../refine/spec-yaml.js";
import { parsePrdInitiatives } from "../menu/prd.js";
import { anchorHash } from "../trace/check.js";
import { setPrdSha } from "../trace/index.js";

const DEFAULT_MODEL = "claude-opus-4-7";

interface Contradiction {
  path?: string;
  current?: string | null;
  issue?: string;
  change?: string;
}
interface ReconcileOutput {
  contradictions: Contradiction[];
  cross_impact: string[];
  updated_spec_yaml: string;
}

function val(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}
const has = (args: string[], flag: string): boolean => args.includes(flag);

function parseOutput(raw: string): ReconcileOutput {
  const stripped = raw.replace(/```json\s*|\s*```/g, "");
  const first = stripped.indexOf("{");
  if (first === -1) throw new Error("reconcile: no JSON object in model response");
  const parsed = JSON.parse(stripped.slice(first));
  return {
    contradictions: Array.isArray(parsed.contradictions) ? parsed.contradictions : [],
    cross_impact: Array.isArray(parsed.cross_impact) ? parsed.cross_impact : [],
    updated_spec_yaml: typeof parsed.updated_spec_yaml === "string" ? parsed.updated_spec_yaml : "",
  };
}

export async function reconcile(argv: string[], _cliVersion: string): Promise<void> {
  const cwd = resolve(val(argv, "--cwd") ?? ".");
  const storyId = val(argv, "--story")?.replace(/^story-/, "");
  const prdRel = val(argv, "--prd") ?? "docs/PRD.md";
  const apply = has(argv, "--apply");
  const dryRun = has(argv, "--dry-run");
  const model = val(argv, "--model") ?? DEFAULT_MODEL;

  if (!storyId) {
    console.error("usage: slowcook reconcile --story <id> [--prd <path>] [--apply] [--dry-run]");
    process.exit(64);
  }

  const spec = listActiveSpecs(cwd).find((s) => s.story_id === storyId);
  if (!spec) {
    console.error(`reconcile: no active spec story-${storyId} in ${SPECS_DIR}/`);
    process.exit(1);
  }
  const anchor = spec.prd_ref?.anchor;
  if (!anchor) {
    console.error(`reconcile: story-${storyId} has no prd_ref.anchor — nothing to reconcile against.`);
    process.exit(1);
  }
  const prdAbs = resolve(cwd, prdRel);
  if (!existsSync(prdAbs)) {
    console.error(`reconcile: no PRD at ${prdRel}.`);
    process.exit(1);
  }
  const init = parsePrdInitiatives(readFileSync(prdAbs, "utf8")).find((i) => i.anchor === anchor);
  if (!init) {
    console.error(`reconcile: PRD has no section §${anchor} (dangling prd_ref).`);
    process.exit(1);
  }

  const specPath = join(resolve(cwd, SPECS_DIR), `story-${storyId}.yaml`);
  const specText = readFileSync(specPath, "utf8");

  const userMessage = [
    `## Changed PRD section`,
    `anchor: ${anchor}`,
    `title: ${init.title}`,
    "",
    init.body,
    "",
    `## Spec to reconcile (story-${storyId})`,
    "```yaml",
    specText,
    "```",
    "",
    "Reconcile per the system prompt; emit a single JSON object.",
  ].join("\n");

  console.log(`reconcile: story-${storyId} ← §${anchor}  (model ${model})`);

  if (dryRun) {
    console.log("[dry-run] would call the model; skipping.");
    return;
  }

  // sc#233 — environment-decided runtime: ANTHROPIC_API_KEY or SLOWCOOK_LLM=claude-cli.
  let llm;
  try {
    llm = await createLlmClient();
  } catch (err) {
    console.error(`reconcile: ${err instanceof Error ? err.message : String(err)} (or pass --dry-run).`);
    process.exit(1);
  }
  const res = await llm.complete({
    system: RECONCILE_SYSTEM,
    cacheSystem: false,
    model,
    messages: [{ role: "user", content: userMessage }],
    maxTokens: 8192,
  });

  let out: ReconcileOutput;
  try {
    out = parseOutput(res.text);
  } catch (e) {
    console.error(`reconcile: couldn't parse model output — ${(e as Error).message}`);
    process.exit(1);
  }

  // Report — the contradictions are the "what changed", reviewable before apply.
  if (out.contradictions.length === 0) {
    console.log("\n  no contradictions — the PRD change doesn't touch this spec's concerns.");
  } else {
    console.log(`\n  ${out.contradictions.length} contradiction(s):`);
    for (const c of out.contradictions) {
      console.log(`    [${c.change ?? "?"}] ${c.path ?? "(?)"} — ${c.issue ?? ""}`);
      if (c.current) console.log(`        was: ${String(c.current).slice(0, 160)}`);
    }
  }
  if (out.cross_impact.length) {
    console.log(`\n  cross-impact (notes only — one hop, not acted on):`);
    for (const n of out.cross_impact) console.log(`    → ${n}`);
  }
  console.log("\n" + formatCostFooter(res.costUsd, []));

  if (!out.updated_spec_yaml.trim()) {
    console.error("\nreconcile: model returned no updated spec — nothing to write.");
    process.exit(1);
  }

  // Validate the proposed spec against the schema before doing anything with it.
  let parsedDoc: unknown;
  try {
    parsedDoc = normalizeScenarioArrays(YAML.parse(out.updated_spec_yaml) as Record<string, unknown>);
  } catch (e) {
    console.error(`\nreconcile: proposed spec isn't valid YAML — ${(e as Error).message}`);
    process.exit(1);
  }
  const check = schemas.Spec.safeParse(parsedDoc);
  if (!check.success) {
    console.error(`\nreconcile: proposed spec fails the spec schema (not applying):`);
    console.error("  " + check.error.issues.slice(0, 5).map((i) => `${i.path.join(".")}: ${i.message}`).join("\n  "));
    // Still write it as a proposal so a human can fix it.
  }

  // Re-stamp the freshness fingerprint so an accepted spec is born fresh.
  const stamped = setPrdSha(out.updated_spec_yaml, anchorHash(init.body));

  if (apply) {
    if (!check.success) {
      console.error("\nreconcile: refusing to --apply an invalid spec. Proposal written instead.");
      const proposalPath = join(resolve(cwd, SPECS_DIR), `story-${storyId}.reconcile.yaml`);
      writeFileSync(proposalPath, stamped);
      console.error(`  proposal: ${SPECS_DIR}/story-${storyId}.reconcile.yaml`);
      process.exit(1);
    }
    writeFileSync(specPath, stamped);
    console.log(`\n✓ applied → ${SPECS_DIR}/story-${storyId}.yaml (re-stamped fresh). Review the diff before committing.`);
  } else {
    const proposalPath = join(resolve(cwd, SPECS_DIR), `story-${storyId}.reconcile.yaml`);
    writeFileSync(proposalPath, stamped);
    console.log(`\n  proposal written → ${SPECS_DIR}/story-${storyId}.reconcile.yaml`);
    console.log(`  review it, then: \`slowcook reconcile --story ${storyId} --apply\`  (or diff & hand-merge).`);
  }
}
