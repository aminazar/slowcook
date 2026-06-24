/**
 * GUCDI — `slowcook menu`. The greenfield entry point: decompose a PRD into a
 * comprehensive, anchored, data-contracted story set written under `specs/`.
 * Each story traces back to a PRD initiative (provenance) and carries the data
 * contract the LCR's SQLite+ORM mock will bake in. The LLM dispatch is the seam
 * (needs ANTHROPIC_API_KEY); the planning (./prd.ts) + assembly (./assemble.ts)
 * are pure + unit-tested.
 *
 *   slowcook menu [--prd docs/PRD.md] [--cwd .] [--model <id>] [--dry-run]
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { relative, resolve } from "node:path";
import { AnthropicClient, MENU_SYSTEM, type MenuStoryDraft } from "@slowcook-ai/llm-anthropic";
import { parsePrdInitiatives } from "./prd.js";
import { assembleStories } from "./assemble.js";
import { writeSpec, nextStoryId, normalizeScenarioArrays } from "../refine/spec-yaml.js";

const DEFAULT_MODEL = "claude-sonnet-4-6";

function val(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

/** Pull the first top-level JSON object out of an agent reply (fence-tolerant). */
export function extractStories(text: string): MenuStoryDraft[] {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const body = fenced ? fenced[1]! : text;
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("no JSON object found");
  const parsed = JSON.parse(body.slice(start, end + 1)) as { stories?: unknown[] };
  // Normalise each story the same way refine does (e.g. {given,when,then} →
  // string), so menu's specs conform to the Spec schema like refine's do.
  return (parsed.stories ?? []).map(
    (s) => normalizeScenarioArrays(s as Record<string, unknown>) as unknown as MenuStoryDraft,
  );
}

export async function menu(argv: string[], cliVersion: string): Promise<void> {
  if (argv[0] === "--help" || argv[0] === "-h") {
    console.log("usage: slowcook menu [--prd <path>] [--cwd <dir>] [--model <id>] [--dry-run]");
    return;
  }
  const cwd = resolve(val(argv, "--cwd") ?? ".");
  const prdRel = val(argv, "--prd") ?? "docs/PRD.md";
  const prdAbs = resolve(cwd, prdRel);
  if (!existsSync(prdAbs)) {
    console.error(`menu: PRD not found at ${prdRel} (pass --prd <path>)`);
    process.exit(64);
  }
  const anthropicKey = process.env["ANTHROPIC_API_KEY"];
  if (!anthropicKey) {
    console.error("menu: ANTHROPIC_API_KEY not set");
    process.exit(64);
  }
  const model = val(argv, "--model") ?? DEFAULT_MODEL;
  const dryRun = argv.includes("--dry-run");

  const prdText = readFileSync(prdAbs, "utf8");
  const initiatives = parsePrdInitiatives(prdText);
  if (initiatives.length === 0) {
    console.error("menu: PRD has no headings — nothing to anchor stories to");
    process.exit(65);
  }
  const prdFile = relative(cwd, prdAbs).replace(/\\/g, "/");

  console.log(`menu: decomposing ${prdFile} (${initiatives.length} initiative(s)) with ${model} ...`);
  const llm = new AnthropicClient(anthropicKey);
  const userMsg =
    `PRD initiative anchors (cite exactly one per story as prd_anchor): ${initiatives.map((i) => i.anchor).join(", ")}\n\n` +
    `--- PRD ---\n${prdText}`;
  // Retry on parse failure: the agent's large JSON is occasionally malformed
  // (non-deterministic) — a fresh attempt usually succeeds. Stream so big
  // outputs aren't truncated.
  let drafts: MenuStoryDraft[] | undefined;
  let lastErr: unknown;
  let lastText = "";
  const ATTEMPTS = 3;
  for (let attempt = 1; attempt <= ATTEMPTS && !drafts; attempt++) {
    const resp = await llm.complete({
      system: MENU_SYSTEM,
      messages: [{ role: "user", content: userMsg }],
      model,
      maxTokens: 64000,
      cacheSystem: true,
      stream: true,
    });
    lastText = resp.text;
    try {
      drafts = extractStories(resp.text);
    } catch (e) {
      lastErr = e;
      if (attempt < ATTEMPTS) {
        console.warn(`menu: attempt ${attempt}/${ATTEMPTS} — JSON parse failed (${e instanceof Error ? e.message : e}); retrying...`);
      }
    }
  }
  if (!drafts) {
    // Dump the raw output so the failure is debuggable, not a silent mystery.
    let dumpPath = "";
    try {
      mkdirSync(resolve(cwd, ".brewing"), { recursive: true });
      dumpPath = resolve(cwd, ".brewing", "menu-raw.txt");
      writeFileSync(dumpPath, lastText, "utf8");
    } catch { /* best-effort */ }
    console.error(`menu: could not parse agent output as JSON after ${ATTEMPTS} attempts — ${String(lastErr instanceof Error ? lastErr.message : lastErr)}`);
    if (dumpPath) console.error(`menu: raw agent output written to ${relative(cwd, dumpPath)} (${lastText.length} chars)`);
    process.exit(70);
  }
  if (drafts.length === 0) {
    console.error("menu: agent emitted no stories");
    process.exit(70);
  }

  const startId = Number.parseInt(await nextStoryId(cwd), 10);
  const { specs, unanchored } = assembleStories(drafts, {
    prdFile,
    startId,
    now: new Date().toISOString(),
    cliVersion,
    validAnchors: initiatives.map((i) => i.anchor),
  });

  console.log(`menu: ${specs.length} stories drafted from ${initiatives.length} initiatives.`);
  for (const u of unanchored) {
    console.warn(`  ⚠ provenance gap: "${u.title}" cites unknown PRD anchor '${u.prd_anchor}'`);
  }
  const deferred = specs.flatMap((s) => s.open_questions?.deferred ?? []);
  const addressable = specs.flatMap((s) => s.open_questions?.addressable ?? []);
  if (addressable.length) console.log(`  ${addressable.length} addressable open question(s) — resolve before scope-complete.`);
  if (deferred.length) console.log(`  ${deferred.length} deferred question(s) — parked for a future amendment.`);

  if (dryRun) {
    for (const s of specs) console.log(`  [dry] story-${s.story_id} — ${s.title} (#${s.prd_ref?.anchor})`);
    return;
  }
  for (const s of specs) {
    const p = writeSpec(cwd, s);
    console.log(`  wrote ${p} (#${s.prd_ref?.anchor})`);
  }
  console.log(`menu: ${specs.length} stories under specs/. Next: brand → vibe each into the LCR.`);
}
