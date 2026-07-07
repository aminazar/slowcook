/**
 * `slowcook extract --history` — tier 1.5 — mine the AGENT SESSIONS THAT BUILT
 * this repo for the knowledge no other source carries: design decisions,
 * REJECTED approaches ("tried X, it deadlocked, so Y"), known issues, and
 * constraints. The code shows what IS; the build history shows WHY.
 *
 * Source: the local ctx index (ctxrs/ctx, Apache-2.0 — see `slowcook recall`),
 * searched per theme over MESSAGE events (decisions live in messages, not
 * command echoes). Only works where the histories live — the builder's own
 * machine — so it's opt-in and degrades honestly: "no build history found".
 *
 * Output: `.brewing/extract-history.json`, survey-claim-shaped so consumers
 * (dash's knowledge sync) ingest it exactly like `--survey` output — every
 * claim cites its session id (inspect with `ctx show session <id>`).
 */
import { homedir } from "node:os";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { ctxAvailable, ctxSearch, type CtxResult, type CtxRunner } from "../recall/ctx.js";

/** claude code stores transcripts under ~/.claude/projects/<path-with-dashes>;
 *  ctx records THAT as the workspace. Map a repo root to candidate workspaces. */
export function workspaceCandidates(repoRoot: string, home: string = homedir()): string[] {
  const abs = resolve(repoRoot);
  const dashed = abs.replace(/\//g, "-"); // "/a/b" → "-a-b"
  return [abs, join(home, ".claude", "projects", dashed)];
}

/** themed probes — SHORT queries, several per theme: ctx's ranked match wants
 *  most words present, so long keyword soups zero out on a workspace-filtered
 *  subset. Short probes hit; the merge dedupes. */
export const HISTORY_THEMES: { kind: string; probes: string[] }[] = [
  { kind: "decision", probes: ["decided", "chose instead", "architecture decision", "settled on"] },
  { kind: "rejected_approach", probes: ["reverted", "abandoned", "didn't work", "failed approach", "dead end"] },
  { kind: "known_issue", probes: ["known bug", "workaround", "flaky", "still broken"] },
  { kind: "constraint", probes: ["invariant", "must never", "hard requirement", "by design"] },
];

export interface HistoryExcerpt { kind: string; sessionId: string; timestamp?: string; snippet: string }

/** search the build history per theme; dedupe by (session, snippet-prefix). */
export function gatherHistory(repoRoot: string, run?: CtxRunner, limitPerTheme = 6): { workspace: string | null; excerpts: HistoryExcerpt[] } {
  if (!ctxAvailable(run)) return { workspace: null, excerpts: [] };
  for (const ws of workspaceCandidates(repoRoot)) {
    // the transcript-dir candidate may exist even when ctx has nothing for the
    // repo path itself; probe each until one yields results.
    const all: HistoryExcerpt[] = [];
    const seen = new Set<string>();
    for (const theme of HISTORY_THEMES) {
      for (const probe of theme.probes) {
        const results: CtxResult[] = ctxSearch({ query: probe, workspace: ws, limit: limitPerTheme }, run);
        for (const r of results) {
          const key = `${r.sessionId}:${r.snippet.slice(0, 60)}`;
          if (seen.has(key)) continue;
          seen.add(key);
          all.push({ kind: theme.kind, sessionId: r.sessionId, timestamp: r.timestamp, snippet: r.snippet });
        }
      }
    }
    if (all.length > 0) return { workspace: ws, excerpts: all };
  }
  return { workspace: null, excerpts: [] };
}

export const HISTORY_SYSTEM = `You are slowcook's build-history archaeologist. The excerpts below come
from the CODING-AGENT SESSIONS THAT BUILT this repository — the discussions
where decisions were made, approaches were tried and abandoned, and bugs were
discovered. Each excerpt is tagged with a candidate kind and its session id.

Extract the durable knowledge: statements a newcomer (or a product intake)
should know that the CODE ITSELF does not say. For each, output:
- kind: "decision" | "rejected_approach" | "known_issue" | "constraint"
- statement: one clear sentence, past tense for history ("X was tried and
  reverted because Y"), present for standing facts.
- session: the session id of the excerpt(s) you drew it from (REQUIRED —
  uncited claims are dropped).
- when: the excerpt's date (YYYY-MM-DD) if present.

Rules: only what the excerpts actually support — no invention, no padding.
Merge duplicates. Skip excerpts that are just command output or pleasantries.
Output STRICT JSON only: {"claims":[{"kind":"...","statement":"...","session":"...","when":"..."}]}`;

export interface HistoryClaim { kind: string; statement: string; session: string; when?: string }

/** validate + citation-enforce the model's output against real session ids. */
export function parseHistoryClaims(text: string, validSessions: Set<string>): HistoryClaim[] {
  const body = text.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim();
  const a = body.indexOf("{"), b = body.lastIndexOf("}");
  if (a < 0 || b < 0) return [];
  try {
    const parsed = JSON.parse(body.slice(a, b + 1)) as { claims?: HistoryClaim[] };
    return (parsed.claims ?? []).filter(
      (c) => typeof c.statement === "string" && c.statement.length > 10 &&
        ["decision", "rejected_approach", "known_issue", "constraint"].includes(c.kind) &&
        typeof c.session === "string" && validSessions.has(c.session), // citation enforcement
    );
  } catch { return []; }
}

/** survey-claim-shaped output, so dash's knowledge sync ingests it as-is. */
export function toSurveyShape(claims: HistoryClaim[]): {
  source: string; area: string; statement: string; status: string; evidence: Record<string, unknown>;
}[] {
  return claims.map((c) => ({
    source: "build_history",
    area: c.kind === "known_issue" ? "quality" : "architecture",
    statement: c.statement,
    // rejected approaches + decisions are testimony from the builder's own
    // sessions — verified-grade provenance; known issues stay unverified
    // (they may have been fixed since).
    status: c.kind === "known_issue" ? "unverified" : "verified",
    evidence: { kind: `history-${c.kind}`, session: c.session, when: c.when ?? null, inspect: `ctx show session ${c.session}` },
  }));
}

export function historyOutputPath(repoRoot: string): string {
  return join(repoRoot, ".brewing", "extract-history.json");
}

export function brewingDirExists(repoRoot: string): boolean {
  return existsSync(join(repoRoot, ".brewing"));
}
