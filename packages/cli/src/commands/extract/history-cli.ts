/**
 * CLI runner for `slowcook extract --history` — gather build-history excerpts
 * via ctx, one LLM pass to distill claims (citation-enforced against real
 * session ids), write `.brewing/extract-history.json` in the survey shape.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { createLlmClient } from "../refine/llm.js";
import { DEFAULT_MODEL } from "./as-built-cli.js";
import {
  gatherHistory, parseHistoryClaims, toSurveyShape, historyOutputPath,
  HISTORY_SYSTEM, type HistoryExcerpt,
} from "./history.js";

export function buildHistoryPrompt(excerpts: HistoryExcerpt[]): string {
  return "Build-history excerpts (each: [kind-hint | session | date] text):\n\n" +
    excerpts.map((e) => `[${e.kind} | ${e.sessionId} | ${(e.timestamp ?? "").slice(0, 10)}]\n${e.snippet}`).join("\n\n");
}

export async function runHistoryCli(repoRoot: string, opts: { model: string | null }): Promise<void> {
  const { workspace, excerpts } = gatherHistory(repoRoot);
  if (excerpts.length === 0) {
    // honest degradation — this repo wasn't built (here) with indexed agents.
    console.log("extract --history: no build history found for this repo in the local ctx index.");
    console.log("  (needs ctxrs/ctx installed + `ctx setup`, and the repo built with a coding agent on THIS machine)");
    return;
  }
  console.log(`extract --history: ${excerpts.length} excerpt(s) from build sessions (workspace: ${workspace}); distilling…`);

  let llm;
  try {
    llm = await createLlmClient();
  } catch (err) {
    console.error(`extract --history: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
  const res = await llm.complete({
    system: HISTORY_SYSTEM,
    cacheSystem: false,
    model: opts.model ?? DEFAULT_MODEL,
    messages: [{ role: "user", content: buildHistoryPrompt(excerpts) }],
    maxTokens: 8000,
  });

  const validSessions = new Set(excerpts.map((e) => e.sessionId));
  const claims = parseHistoryClaims(res.text, validSessions);
  if (claims.length === 0) {
    console.log("extract --history: the model distilled no citable claims from the excerpts — nothing written.");
    return;
  }
  const out = {
    generated_by: "slowcook extract --history",
    workspace,
    excerpts_seen: excerpts.length,
    claims: toSurveyShape(claims),
  };
  const path = historyOutputPath(repoRoot);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(out, null, 2) + "\n");
  const byKind = claims.reduce<Record<string, number>>((m, c) => ((m[c.kind] = (m[c.kind] ?? 0) + 1), m), {});
  console.log(`extract --history: wrote ${claims.length} claim(s) → ${path}`);
  console.log(`  ${Object.entries(byKind).map(([k, n]) => `${k}: ${n}`).join(" · ")}`);
}
