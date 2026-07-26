/**
 * Journey SYNTHESIS — the spec-only path of `vibe journeys` (no concept.yaml).
 * The LLM chains personas + acceptance scenarios into ordered, timely walks;
 * output is schema-validated with ONE format retry (the vibe convention).
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { AnthropicClient, JOURNEYS_SYSTEM, formatCostFooter } from "@slowcook-ai/llm-anthropic";
import { JourneysFileSchema } from "./journeys-schema.js";

function stripFence(s: string): string {
  const m = s.match(/```(?:yaml|yml)?\n([\s\S]*?)```/);
  return (m ? m[1]! : s).trim() + "\n";
}

export async function synthesizeJourneys(opts: { cwd: string; outPath: string; dryRun: boolean; model?: string }): Promise<void> {
  const { buildSpecsDigest } = await import("./index.js");
  const digest = buildSpecsDigest(opts.cwd);
  if (!digest.trim()) {
    console.error("vibe journeys: no concept.yaml and no active specs — nothing to compile from. Run `menu` first (or add a concept)." );
    process.exit(1);
  }
  const user = `## Specs digest (personas · surfaces+routes+states · acceptance scenarios)\n${digest}\n\nWrite the journeys YAML now.`;

  if (opts.dryRun) {
    console.log("vibe journeys [dry-run, synthesis] — no concept.yaml; would send:");
    console.log(`--- system (${JOURNEYS_SYSTEM.length} chars) ---\n${JOURNEYS_SYSTEM.slice(0, 400)}…`);
    console.log(`--- user (${user.length} chars) ---\n${user.slice(0, 400)}…`);
    return;
  }

  const apiKey = process.env["ANTHROPIC_API_KEY"];
  if (!apiKey) { console.error("vibe journeys: ANTHROPIC_API_KEY not set (synthesis path needs the LLM; --dry-run to inspect)."); process.exit(1); }
  const llm = new AnthropicClient(apiKey);
  const model = opts.model ?? "claude-opus-4-8";

  let totalUsd = 0;
  let text = "";
  for (let attempt = 1; attempt <= 2; attempt++) {
    const res = await llm.complete({
      system: JOURNEYS_SYSTEM,
      model,
      maxTokens: 24000,
      stream: true,
      messages: [{ role: "user", content: attempt === 1 ? user : `${user}\n\nYour previous output failed schema validation:\n${text.slice(0, 800)}\n\nEmit ONLY the corrected YAML document.` }],
    });
    totalUsd += res.costUsd;
    text = stripFence(res.text);
    const parsed = JourneysFileSchema.safeParse(parseYamlSafe(text));
    if (parsed.success) {
      mkdirSync(dirname(opts.outPath), { recursive: true });
      writeFileSync(opts.outPath, stringifyYaml(parsed.data));
      console.log(`vibe journeys — synthesized ${parsed.data.journeys.length} journeys → ${opts.outPath}`);
      console.log("\n" + formatCostFooter(totalUsd, []));
      return;
    }
    if (attempt === 2) {
      console.error("vibe journeys: synthesis failed schema validation twice:");
      for (const issue of parsed.error.issues.slice(0, 8)) console.error(`  ${issue.path.join(".")}: ${issue.message}`);
      process.exit(1);
    }
  }
}

function parseYamlSafe(text: string): unknown {
  try { return parseYaml(text); } catch { return null; }
}
