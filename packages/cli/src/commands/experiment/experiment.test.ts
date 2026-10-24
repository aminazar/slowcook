import { describe, it, expect } from "vitest";
import { mergeArms, DEFAULT_ARMS, resolveArm, runIdFor } from "./arms.js";
import { buildPlainPrompt, plainArgv, runPlainArm, PLAIN_DONE_MARKER, PLAIN_NUDGE } from "./arm-plain.js";
import { aggregateRuns, isSelectorOnlyFailure, summarizeOne, priceBasis } from "./report.js";
import { rediscoverySignal, wrongSignatureSignal, wrongFileSignal, lostClarificationSignal, reasoningSignal, draftClass, classifyRun } from "./classify.js";
import { storyArtifactPaths } from "./tree.js";
import { parseRunArgs, brewArgv, modelsFor } from "./run.js";
import type { LoadedRun, RunRecord } from "./records.js";

const price = (model: string, u: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheCreateTokens: number }) =>
  model === "unpriced" ? null : (u.inputTokens * 1 + u.outputTokens * 5) / 1_000_000;

describe("arms", () => {
  it("defaults name three arms; overrides merge env and may add arms", () => {
    const arms = mergeArms(DEFAULT_ARMS, { swarm: { env: { SLOWCOOK_MODEL_BREW: "claude-haiku-4-5" } }, mine: { kind: "brew", env: { X: "1" }, notes: "n" } });
    expect(arms["swarm"]!.env).toMatchObject({ SLOWCOOK_LLM: "claude-cli", SLOWCOOK_MODEL_BREW: "claude-haiku-4-5" });
    expect(arms["swarm"]!.flags).toContain("--with-navigator");
    // brew arms never write to GitHub: they re-implement shipped stories
    expect(arms["swarm"]!.env["SLOWCOOK_BREW_LOCAL"]).toBe("1");
    expect(arms["pipeline"]!.env["SLOWCOOK_BREW_LOCAL"]).toBe("1");
    expect(DEFAULT_ARMS["plain"]!.env["SLOWCOOK_BREW_LOCAL"]).toBeUndefined();
    expect(arms["mine"]).toMatchObject({ name: "mine", kind: "brew", flags: [] });
    expect(() => mergeArms(DEFAULT_ARMS, { bad: { env: {} } })).toThrow(/kind/);
    expect(() => resolveArm(arms, "nope")).toThrow(/known: mine, pipeline, plain, swarm/);
    expect(runIdFor("e", "007", "plain", 2)).toBe("e/007/plain/2");
  });
});

describe("plain arm", () => {
  it("prompt is issue text only and asks for the done marker; argv has no MCP flags and native tools allowed", () => {
    const p = buildPlainPrompt({ number: 12, title: "Add bookmarks", body: "Users can save posts." });
    expect(p).toContain("issue #12");
    expect(p).toContain("# Add bookmarks");
    expect(p).toContain("Users can save posts.");
    expect(p.trim().endsWith(PLAIN_DONE_MARKER)).toBe(true);
    expect(p).not.toMatch(/spec|manifest|tests\//i);
    const argv = plainArgv({ prompt: p, model: "claude-sonnet-5-5", maxTurns: 40 });
    expect(argv.join(" ")).not.toMatch(/--mcp-config|--disallowedTools/);
    expect(argv).toContain("--allowedTools");
    expect(argv[argv.indexOf("--allowedTools") + 1]).toMatch(/^Bash,Read,Write,Edit/);
    expect(plainArgv({ prompt: p, model: "m", maxTurns: 1, sessionId: "s1" }).slice(-2)).toEqual(["--resume", "s1"]);
  });

  const result = (text: string, subtype = "success", session = "s1") =>
    [
      JSON.stringify({ type: "system", session_id: session }),
      JSON.stringify({ type: "result", subtype, is_error: false, num_turns: 3, result: text, usage: { input_tokens: 100000, output_tokens: 10000 } }),
    ].join("\n");

  it("resumes while cut at max-turns, nudges once when the marker is missing, stops on the marker; budget at list price", async () => {
    const seen: string[][] = [];
    const outs = [result("partial", "error_max_turns"), result("I think I'm done."), result(`all set\n${PLAIN_DONE_MARKER}`)];
    const r = await runPlainArm({
      repoRoot: "/t", issue: { number: 1, title: "t", body: "b" }, model: "m", budgetUsd: 5, priceFor: price,
      exec: (_c, xs) => { seen.push(xs); return { stdout: outs.shift()!, status: 0 }; },
    });
    expect(r.done).toBe(true);
    expect(r.stop).toBe("done");
    expect(r.sessions).toBe(3);
    expect(r.turns).toBe(9);
    expect(r.usd).toBeCloseTo(3 * (100000 * 1 + 10000 * 5) / 1_000_000, 6);
    expect(seen[1]![1]).toBe("Continue.");
    expect(seen[1]).toContain("--resume");
    expect(seen[2]![1]).toBe(PLAIN_NUDGE);
  });

  it("stops on budget and reports unpriced models honestly", async () => {
    const r = await runPlainArm({
      repoRoot: "/t", issue: { number: 1, title: "t", body: "" }, model: "m", budgetUsd: 0.1, priceFor: price,
      exec: () => ({ stdout: result("more", "error_max_turns"), status: 0 }),
    });
    expect(r.stop).toBe("budget");
    expect(r.sessions).toBe(1);
    const u = await runPlainArm({
      repoRoot: "/t", issue: { number: 1, title: "t", body: "" }, model: "unpriced", budgetUsd: 0.1, priceFor: price, maxSessions: 2,
      exec: () => ({ stdout: result("more", "error_max_turns"), status: 0 }),
    });
    expect(u.unpriced).toBe(true);
    expect(u.usd).toBeNull();
    expect(u.stop).toBe("sessions");
  });

  it("an erroring session stops with its text", async () => {
    const r = await runPlainArm({
      repoRoot: "/t", issue: { number: 1, title: "t", body: "" }, model: "m", budgetUsd: 1, priceFor: price,
      exec: () => ({ stdout: JSON.stringify({ type: "result", subtype: "error", is_error: true, result: "Not logged in" }), status: 1 }),
    });
    expect(r.stop).toBe("error");
    expect(r.errorText).toContain("Not logged in");
  });
});

function run(partial: Partial<RunRecord> & { story: string; arm: string; seed?: number }, extra: Partial<LoadedRun> = {}): LoadedRun {
  const seed = partial.seed ?? 1;
  return {
    dir: `/x/${partial.story}/${partial.arm}-${seed}`,
    record: { run_id: `e/${partial.story}/${partial.arm}/${seed}`, exp: "e", kind: "brew", seed, base_ref: "main", base_sha: "abc", models: { brew: "m" }, env_names: [], flags: [], tree: "/x", started_at: "t", ...partial },
    cost: [],
    ...extra,
  };
}

describe("report", () => {
  it("isSelectorOnlyFailure separates missing-hook failures from behavioural ones", () => {
    expect(isSelectorOnlyFailure('TestingLibraryElementError: Unable to find an element by: [data-testid="save"]')).toBe(true);
    expect(isSelectorOnlyFailure("expected 404 to be 201")).toBe(false);
    expect(isSelectorOnlyFailure(undefined)).toBe(false);
  });

  it("aggregates story × arm over seeds; unpriced never sums as 0; regressions diff against base", () => {
    const verify = (green: number, total: number, outside: number, reds: Array<{ id: string; message?: string }> = []) =>
      ({ story: "7", base: "main", ok: green === total, sections: [], story_contract: { green, total, not_run: 0, red_ids: reds.map((r) => r.id), red: reds }, full_suite: { red_outside_story: outside, red_files: [] }, typecheck: { total_errors: 0, regressions: [], baseline_recorded: false } });
    const baseVerify = verify(0, 5, 2);
    const runs: LoadedRun[] = [
      run({ story: "7", arm: "pipeline", seed: 1, wall_ms: 600_000 }, { verify: verify(5, 5, 2), baseVerify, cost: [{ agent: "brew", usd: 1, model: "m", at: "a", tokens_in: 1_000_000, tokens_out: 0 }], summary: { story_id: "7", outcome: "success", halt_reason: "SUCCESS_ALL_GREEN", model: "m", iterations: 4, checkpoints: 2, green: 5, total: 5, usd: 1 } }),
      run({ story: "7", arm: "pipeline", seed: 2, wall_ms: 1_200_000 }, { verify: verify(5, 5, 3), baseVerify, cost: [{ agent: "brew", usd: 2, model: "m", at: "a", tokens_in: 2_000_000, tokens_out: 0 }], summary: { story_id: "7", outcome: "success", halt_reason: "SUCCESS_ALL_GREEN", model: "m", iterations: 6, checkpoints: 3, green: 5, total: 5, usd: 2 } }),
      run({ story: "7", arm: "swarm", seed: 1 }, { verify: verify(3, 5, 2, [{ id: "a", message: "Unable to find an element by: [data-testid=x]" }, { id: "b", message: "expected 1 to be 2" }]), baseVerify, cost: [{ agent: "brew", usd: null, model: "unpriced", at: "a", tokens_in: 10, tokens_out: 1 }], halt: { story_id: "7", halt_reason: "STAGNATION_CAP", halt_timestamp: "t", iterations_run: 9, checkpoints_committed: 1, tests_green: 3, tests_total: 5, tokens_spent_usd: 0, budget_usd: 1, model: "unpriced", summary_plain_english: "", suggested_actions: [] } }),
      run({ story: "7", arm: "plain", kind: "plain", seed: 1, models: { plain: "m" } }, { verify: verify(2, 5, 2, [{ id: "a", message: "Unable to find an element by: [data-testid=x]" }, { id: "b", message: "Unable to find an element by: [data-testid=y]" }, { id: "c", message: "expected 1 to be 2" }]), baseVerify, plain: { done: true, sessions: 2, turns: 20, usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreateTokens: 0 }, usd: 0.4, unpriced: false, stop: "done", lastText: "", started_at: "a", finished_at: "b", wall_ms: 300_000 } }),
    ];
    const rows = aggregateRuns(runs, price);
    expect(rows.map((r) => r.arm)).toEqual(["pipeline", "plain", "swarm"]);
    const pipe = rows[0]!;
    // repriced in memory from tokens: 1M in → $1, 2M in → $2 → mean 1.5
    expect(pipe).toMatchObject({ n: 2, cost_usd: 1.5, green: 5, total: 5, verdict: "all-green", new_full_suite_reds: 1, wall_min: 15, iterations: 5 });
    const swarm = rows[2]!;
    expect(swarm.cost_usd).toBeNull();
    expect(swarm.unpriced_rows).toBe(1);
    expect(swarm).toMatchObject({ verdict: "partial", selector_only_red: 1, behavioural_red: 1, halt_reasons: ["STAGNATION_CAP"] });
    const plain = rows[1]!;
    expect(plain).toMatchObject({ cost_usd: 0.4, selector_only_red: 2, behavioural_red: 1, wall_min: 5, iterations: 20, halt_reasons: ["plain:done"] });
    const never = summarizeOne(run({ story: "9", arm: "pipeline", error: "dirty checkout" }), price);
    expect(never).toMatchObject({ verdict: "no-verify", cost_usd: null, halt_reason: "RUN_ERROR" });
    // typecheck: base already carried file a at 3 errors; only file b is the arm's
    const tv = (regs: Array<{ file: string; was: number; now: number }>) => ({ story: "7", base: "main", ok: true, sections: [], typecheck: { total_errors: 0, regressions: regs, baseline_recorded: false } });
    const tc = summarizeOne(run({ story: "7", arm: "pipeline" }, { verify: tv([{ file: "a", was: 1, now: 3 }, { file: "b", was: 0, now: 2 }]), baseVerify: tv([{ file: "a", was: 1, now: 3 }]) }), price);
    expect(tc.typecheck_regressions).toBe(1);
    expect(priceBasis(runs, price).map((b) => b.model)).toEqual(["m", "unpriced"]);
    expect(priceBasis(runs, price)[1]).toEqual({ model: "unpriced", in_per_m: null, out_per_m: null });
  });
});

describe("classify signals", () => {
  it("re-discovery: a file read in ≥3 iterations and never written", () => {
    const log = [
      "ITER 1 TOOLS  3/3 calls  auth=subscription ($ at list price)  model=m: read_file(src/a.ts), read_file(src/b.ts), outline_file(src/c.ts)",
      "ITER 2 TOOLS  2/2 calls  auth=subscription ($ at list price)  model=m: read_file(src/a.ts), write_file(src/b.ts)",
      "ITER 3 TOOLS  2/2 calls  auth=subscription ($ at list price)  model=m: read_file(src/a.ts), read_file(src/b.ts)",
      "ITER 3 CHECKPOINT something",
    ].join("\n");
    const s = rediscoverySignal(log);
    expect(s).toHaveLength(1);
    expect(s[0]!.evidence).toContain("src/a.ts read in iterations 1,2,3");
    expect(rediscoverySignal("ITER 1 START\nITER 2 START")).toEqual([]);
  });

  it("wrong-signature / wrong-file / lost-clarification / reasoning fire on their evidence only", () => {
    expect(wrongSignatureSignal([{ id: "t1", message: "TypeError: svc.saveBookmark is not a function" }, { id: "t2", message: "expected 1 to be 2" }])).toHaveLength(1);
    const wf = wrongFileSignal(["src/lib/bookmarks.ts", "src/lib/other.ts", "tests/x.test.ts"], [{ file: "tests/x.test.ts", specifiers: ["@/lib/bookmarks", "vitest"] }]);
    expect(wf.map((s) => s.evidence)).toEqual(["src/lib/other.ts edited; no story test imports it"]);
    expect(wrongFileSignal(["src/a.ts"], [])).toEqual([]);
    expect(lostClarificationSignal(["Bookmarks toggle must call /api/bookmarks with the post id"], ["tests/b.test.ts > bookmarks > toggle calls /api/bookmarks"])).toHaveLength(1);
    expect(lostClarificationSignal(["Unrelated clarification about billing"], ["tests/b.test.ts > bookmarks > toggle"])).toEqual([]);
    expect(reasoningSignal("The ordering of the two awaits is wrong")).toHaveLength(1);
    expect(reasoningSignal(undefined)).toEqual([]);
  });

  it("draft class: harness wins, then the most frequent knowledge kind, then reasoning, else none", () => {
    expect(draftClass([{ kind: "reasoning", evidence: "" }, { kind: "harness", evidence: "" }])).toBe("harness");
    expect(draftClass([{ kind: "knowledge/wrong-file", evidence: "" }, { kind: "knowledge/wrong-file", evidence: "" }, { kind: "knowledge/wrong-signature", evidence: "" }, { kind: "reasoning", evidence: "" }])).toBe("knowledge/wrong-file");
    expect(draftClass([{ kind: "reasoning", evidence: "" }])).toBe("reasoning");
    expect(draftClass([])).toBe("none");
  });

  it("classifyRun keeps a prior confirmation and reports evidence", () => {
    const r = run({ story: "7", arm: "swarm" }, {
      halt: { story_id: "7", halt_reason: "TEST_RUNNER_BROKEN", halt_timestamp: "t", iterations_run: 1, checkpoints_committed: 0, tests_green: 0, tests_total: 5, tokens_spent_usd: 0, budget_usd: 1, model: "m", summary_plain_english: "", suggested_actions: [] },
      classification: { run_id: "e/7/swarm/1", signals: [], draft_class: "none", confirmed_class: "harness", confirmed_by: "amin", generated_at: "t" },
    });
    const c = classifyRun(r, {}, () => new Date(0));
    expect(c.draft_class).toBe("harness");
    expect(c.confirmed_class).toBe("harness");
    expect(c.signals[0]!.evidence).toContain("TEST_RUNNER_BROKEN");
  });
});

describe("tree + run args", () => {
  it("storyArtifactPaths collects the spec, sidecar, manifest and every story test file", () => {
    const got = storyArtifactPaths("007", [{ file: "tests/integration/story-007-ui.test.tsx" }], [
      "specs/story-007.yaml", "specs/story-007.cost.jsonl", "specs/story-008.yaml", ".brewing/manifests/story-007.json",
      "tests/integration/story-007-ui.test.tsx", "tests/db/story-7-rls.test.ts", "tests/db/story-0070.test.ts", "src/a.ts",
    ]);
    expect(got).toEqual([
      ".brewing/manifests/story-007.json", "specs/story-007.cost.jsonl", "specs/story-007.yaml",
      "tests/db/story-7-rls.test.ts", "tests/integration/story-007-ui.test.tsx",
    ]);
  });

  it("parseRunArgs defaults and validation; brewArgv and modelsFor are what --dry-run prints", () => {
    const a = parseRunArgs(["--story", "story-007", "--arm", "swarm", "--seed", "2", "--budget-usd", "2.5", "--dry-run"], () => new Date("2026-10-24T00:00:00Z"));
    expect(a).toMatchObject({ storyId: "007", arm: "swarm", seed: 2, budgetUsd: 2.5, dryRun: true, exp: "exp-2026-10-24", base: "main" });
    expect(() => parseRunArgs(["--arm", "x"])).toThrow(/--story/);
    expect(() => parseRunArgs(["--story", "1", "--arm", "x", "--seed", "0"])).toThrow(/--seed/);
    expect(parseRunArgs(["--story", "1", "--arm", "plain", "--oracle-suites", "backend, unit"]).oracleSuites).toEqual(["backend", "unit"]);
    expect(brewArgv({ cliEntry: "/cli.js", storyId: "7", tree: "/t", base: "main", budgetUsd: 2, flags: ["--with-navigator"] }))
      .toEqual(["/cli.js", "brew", "--story", "7", "--cwd", "/t", "--base", "main", "--budget-usd", "2", "--with-navigator"]);
    const m = modelsFor(DEFAULT_ARMS["swarm"]!, {});
    expect(m["brew"]).toBe("claude-haiku-5-5");
    expect(m["navigator"]).toBe("claude-fable-5-1");
    expect(modelsFor(DEFAULT_ARMS["plain"]!, {})).toEqual({ plain: "claude-sonnet-5-5" });
    expect(modelsFor(DEFAULT_ARMS["pipeline"]!, { SLOWCOOK_MODEL: "claude-opus-5-5" })["brew"]).toBe("claude-opus-5-5");
  });
});

describe("not-run tests are never green", () => {
  it("verdict is partial, not all-green, when expected tests had no result", async () => {
    const { verdictFor } = await import("./report.js");
    expect(verdictFor(3, 5, true, 2)).toBe("partial");
    expect(verdictFor(5, 5, true, 0)).toBe("all-green");
  });
  it("base verify is keyed by the oracle's suite set", async () => {
    const { baseVerifyName } = await import("./records.js");
    expect(baseVerifyName(undefined)).toBe("base.verify.json");
    expect(baseVerifyName(["db", "backend"])).toBe("base.verify.backend+db.json");
  });
});
