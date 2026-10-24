/**
 * `slowcook experiment classify --run <id>` — ruling 1's instrument.
 *
 * For each cheap-model failure the question is: did the model lack
 * KNOWLEDGE it could have been handed (which file, which signature, a
 * clarification the PM already gave, facts it re-discovered every
 * iteration) or did it REASON wrongly on correct inputs? The answer
 * decides the substrate (a sha-keyed cache vs. the Datumesh resolver).
 *
 * This emits a DRAFT from deterministic signals, with the evidence each
 * signal fired on, for a human to confirm (`--confirm <class> --by <name>`).
 * The tool produces evidence; the class is a judgment. (An agent blaming
 * the harness was right once and got dismissed — #548 — so "harness" is a
 * first-class outcome, and no draft is final.)
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { importResolvesTo } from "../taste/head-files.js";
import type { Classification, LoadedRun } from "./records.js";

export interface Signal { kind: string; evidence: string }

export const HARNESS_HALTS = new Set([
  "TEST_RUNNER_BROKEN", "MANIFEST_DRIFT", "MANIFEST_MISSING", "TESTS_BROKEN",
  "FINAL_GATE_RUNNER_BROKEN", "API_ERROR",
]);

/**
 * Re-discovery: the same file read in ≥ `minIterations` iterations and
 * never written. Reads brew's `ITER n TOOLS … : read_file(path), …` lines
 * (the claude-cli backend logs them; the SDK backend logs none — then this
 * signal cannot fire and says so). Pure.
 */
export function rediscoverySignal(iterationsLog: string, minIterations = 3): Signal[] {
  const readsByFile = new Map<string, Set<number>>();
  const written = new Set<string>();
  let sawToolLines = false;
  for (const line of iterationsLog.split("\n")) {
    const m = line.match(/ITER (\d+) TOOLS .*?: (.*)$/);
    if (!m) continue;
    sawToolLines = true;
    const iter = Number(m[1]);
    for (const call of m[2]!.split(", ")) {
      const c = call.match(/^(read_file|outline_file|write_file|edit_file|search_replace)\(([^)]+)\)/);
      if (!c) continue;
      const [, tool, path] = c as [string, string, string];
      if (tool === "read_file" || tool === "outline_file") {
        const s = readsByFile.get(path) ?? new Set<number>();
        s.add(iter);
        readsByFile.set(path, s);
      } else written.add(path);
    }
  }
  if (!sawToolLines) return [];
  const out: Signal[] = [];
  for (const [path, iters] of readsByFile) {
    if (iters.size >= minIterations && !written.has(path)) {
      out.push({ kind: "knowledge/re-discovery", evidence: `${path} read in iterations ${[...iters].sort((a, b) => a - b).join(",")} and never written` });
    }
  }
  return out;
}

/** Wrong signature: a red test's failure text names a surface the code does not have. Pure. */
export function wrongSignatureSignal(reds: Array<{ id: string; message?: string }>): Signal[] {
  const re = /is not a function|Cannot read propert(y|ies) of (undefined|null)|does not exist on type|has no exported member|is not exported|Expected \d+ arguments?, but got|is not defined|Cannot find module|Cannot destructure property/i;
  return reds
    .filter((r) => r.message && re.test(r.message))
    .map((r) => ({ kind: "knowledge/wrong-signature", evidence: `${r.id.slice(0, 100)}: ${r.message!.split("\n")[0]!.slice(0, 160)}` }));
}

/**
 * Wrong file: a checkpointed edit landed in a source file that none of the
 * story's tests import (directly). Tests' import specifiers are captured by
 * `run.ts` while the tree exists. Pure.
 */
export function wrongFileSignal(
  filesTouched: string[],
  testImports: Array<{ file: string; specifiers: string[] }>
): Signal[] {
  if (testImports.length === 0) return [];
  const out: Signal[] = [];
  for (const f of filesTouched) {
    if (!/^(src|app|lib|components|server)\//.test(f) && !f.includes("/src/")) continue;
    // A static-check test names the file by PATH instead of importing it
    // (the first smoke run's false positive): a literal path counts.
    const imported = testImports.some((t) => t.specifiers.some((s) => s === f || f.endsWith(s) || importResolvesTo(s, t.file, f)));
    if (!imported) out.push({ kind: "knowledge/wrong-file", evidence: `${f} edited; no story test imports it` });
  }
  return out;
}

/** Lost clarification: a PM clarification names something a red test names. Pure. */
export function lostClarificationSignal(clarifications: string[], redIds: string[]): Signal[] {
  const out: Signal[] = [];
  const idTokens = new Set(redIds.flatMap((id) => id.toLowerCase().match(/[a-z][a-z0-9_-]{3,}/g) ?? []));
  for (const c of clarifications) {
    const toks = (c.toLowerCase().match(/[a-z][a-z0-9_-]{4,}/g) ?? []).filter((t) => idTokens.has(t));
    if (toks.length >= 2) out.push({ kind: "knowledge/lost-clarification", evidence: `clarification "${c.slice(0, 80)}" shares ${[...new Set(toks)].slice(0, 4).join(",")} with a red test` });
  }
  return out;
}

/** The agent's own rationale cites logic/order/async — reasoning, not knowledge. Pure. */
export function reasoningSignal(rationale: string | undefined): Signal[] {
  if (!rationale) return [];
  const m = rationale.match(/\b(race|ordering|order of|async|await|timing|sequence|off[- ]by[- ]one|logic|invariant|state machine|edge case)\b/i);
  return m ? [{ kind: "reasoning", evidence: `rationale cites "${m[0]}": ${rationale.slice(0, 140)}` }] : [];
}

export function harnessSignal(haltReason: string | undefined): Signal[] {
  return haltReason && HARNESS_HALTS.has(haltReason) ? [{ kind: "harness", evidence: `halt ${haltReason} — the harness, not the model` }] : [];
}

const STALL_HALTS = new Set(["AGENT_STALLED_NO_EDITS", "AGENT_SELF_REPORTED_STUCK"]);

/**
 * A stall whose rationale names the CONTRACT — a test that requires the
 * opposite of another, a mock helper that records nothing, an assertion on
 * an escaped character, an attribute count — is a contract defect, not a
 * model failure. Amin's ruling (2026-10-24) on set-1: every non-harness halt
 * was such a stall, the drafts said wrong-file/reasoning, and that
 * misclassification is exactly what would have falsely supported the cell
 * store. The #548 lesson, mechanized: when the agent blames the test with
 * specifics, the draft is `harness`. Pure.
 */
export function contractDefectSignal(haltReason: string | undefined, rationale: string | undefined): Signal[] {
  if (!haltReason || !STALL_HALTS.has(haltReason) || !rationale) return [];
  const namesContract = /\b(tests?|assertions?|asserts?|expects?|mocks?|helpers?|fixtures?|manifest|spec)\b/i.test(rationale);
  const saysUnsatisfiable = /\b(opposite|contradict\w*|cannot|can't|not fixable|outside (the )?(component|src)|would (only )?(lie|reproduce)|requires? \d+|needs? a change (outside|in tests?)|unsatisfiable|escapes?)\b/i.test(rationale);
  if (!namesContract || !saysUnsatisfiable) return [];
  return [{ kind: "harness", evidence: `stall rationale names a contract defect (#548: the agent blaming the test was right): ${rationale.replace(/\s+/g, " ").slice(0, 200)}` }];
}

/**
 * The story's own tests all green and the full-suite gate red on ANOTHER
 * story's test: two merged contracts in conflict (set-1 seed 2: 017's
 * rewo_id vs 016's rewoSlug, 022's 401 body vs the B-7 regression test).
 * Both models made the same move; it is the contract, not the model. The
 * human still decides — a true regression looks the same from here, which
 * the evidence says. Pure.
 */
export function crossContractSignal(
  haltReason: string | undefined,
  storyId: string,
  contract: { green: number; total: number } | undefined,
  summary: string | undefined
): Signal[] {
  if (haltReason !== "TRANSITIVE_REGRESSION" || !contract || contract.total === 0 || contract.green < contract.total) return [];
  const m = summary?.match(/`([^`]*story-0*(\d+)[^`]*)`/);
  const other = m && m[2] && m[2].replace(/^0+/, "") !== storyId.replace(/^0+/, "") ? m[1] : undefined;
  if (!other) return [];
  return [{ kind: "harness", evidence: `story tests all green; the gate's first regression is another story's test (${other.slice(0, 100)}) — two merged contracts conflict, or a true regression: human decides` }];
}

/** The agent stopped acting WITHOUT naming a contract problem: reasoning, not knowledge. Pure. */
export function stallSignal(haltReason: string | undefined, iterations: number | undefined, rationale?: string): Signal[] {
  if (!haltReason || !STALL_HALTS.has(haltReason)) return [];
  if (contractDefectSignal(haltReason, rationale).length > 0) return [];
  return [{ kind: "reasoning", evidence: `halt ${haltReason} after ${iterations ?? "?"} iteration(s): the model read and then did not act, and gave no contract reason` }];
}

/** harness > the most frequent knowledge kind > reasoning > none. Pure. */
export function draftClass(signals: Signal[]): Classification["draft_class"] {
  if (signals.some((s) => s.kind === "harness")) return "harness";
  const counts = new Map<string, number>();
  for (const s of signals) if (s.kind.startsWith("knowledge/")) counts.set(s.kind, (counts.get(s.kind) ?? 0) + 1);
  if (counts.size > 0) {
    return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]![0] as Classification["draft_class"];
  }
  if (signals.some((s) => s.kind === "reasoning")) return "reasoning";
  return "none";
}

export interface ClassifyExtras {
  iterationsLog?: string;
  testImports?: Array<{ file: string; specifiers: string[] }>;
  clarifications?: string[];
}

export function classifyRun(run: LoadedRun, extras: ClassifyExtras, now: () => Date = () => new Date()): Classification {
  // Only the reds this arm REACHED carry a signal: a test red at base too was
  // never attempted (the stalled swarm arm's "wrong signatures" were base's).
  const baseRed = new Set(run.baseVerify?.story_contract?.red_ids ?? []);
  const allReds = run.verify?.story_contract?.red ?? [];
  const reds = run.baseVerify ? allReds.filter((r) => !baseRed.has(r.id)) : allReds;
  const untouched = allReds.length - reds.length;
  const touched = [...new Set((run.halt?.iteration_diffs ?? []).filter((d) => d.outcome === "checkpoint").flatMap((d) => d.files_touched))];
  const signals: Signal[] = [
    ...harnessSignal(run.halt?.halt_reason ?? run.summary?.halt_reason),
    ...contractDefectSignal(run.halt?.halt_reason ?? run.summary?.halt_reason, run.halt?.last_agent_rationale),
    ...crossContractSignal(run.halt?.halt_reason ?? run.summary?.halt_reason, run.record.story, run.verify?.story_contract, run.halt?.summary_plain_english),
    ...stallSignal(run.halt?.halt_reason ?? run.summary?.halt_reason, run.halt?.iterations_run ?? run.summary?.iterations, run.halt?.last_agent_rationale),
    ...(untouched > 0 ? [{ kind: "note", evidence: `${untouched} red test(s) were already red at base — not attributed to this arm` }] : []),
    ...rediscoverySignal(extras.iterationsLog ?? ""),
    ...wrongSignatureSignal(reds),
    ...wrongFileSignal(touched, extras.testImports ?? []),
    ...lostClarificationSignal(extras.clarifications ?? [], reds.map((r) => r.id)),
    ...reasoningSignal(run.halt?.last_agent_rationale),
  ];
  const green = run.verify?.story_contract;
  const allGreen = green && green.total > 0 && green.green === green.total;
  return {
    run_id: run.record.run_id,
    signals,
    draft_class: allGreen && signals.length === 0 ? "none" : draftClass(signals),
    ...(run.classification?.confirmed_class ? { confirmed_class: run.classification.confirmed_class, confirmed_by: run.classification.confirmed_by, note: run.classification.note } : {}),
    generated_at: now().toISOString(),
  };
}

export function writeClassification(dir: string, c: Classification): string {
  const p = join(dir, "classification.json");
  writeFileSync(p, JSON.stringify(c, null, 2) + "\n", "utf8");
  return p;
}
