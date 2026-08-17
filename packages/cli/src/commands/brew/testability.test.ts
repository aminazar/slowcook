// Peel, don't deadlock (ARM-B post-mortem). "Monolithic" is masking, not
// atomicity — the shared prefix hides an independent gradient.
import { describe, it, expect } from "vitest";
import { failureRoot, detectMaskedMonolith, peelTargetPrompt, peelResolved, diagnoseToolFailure, peelIsStandaloneCheckpoint, type FailedTest } from "./testability.js";

const fail = (id: string, msg: string): FailedTest => ({ id, status: "failed", failure_message: msg });

describe("failureRoot", () => {
  it("collapses per-test noise so identical deploy reverts share a key", () => {
    const a = failureRoot("setUp() reverted: STUB not deployed at 0x1a2b3c [256 runs, μ: 41000]");
    const b = failureRoot("setUp() reverted: STUB not deployed at 0x9f8e7d [256 runs, μ: 40912]");
    expect(a).toBe(b);
    expect(a).toContain("STUB not deployed");
    expect(a).not.toContain("0x1a2b");
  });
  it("keeps genuinely different causes distinct", () => {
    expect(failureRoot("AssertionError: exports differ")).not.toBe(failureRoot("setUp() reverted: no funds"));
  });
});

describe("detectMaskedMonolith", () => {
  it("flags the ARM-B shape: every test behind one deploy revert", () => {
    const nine = Array.from({ length: 9 }, (_, i) =>
      fail(`t${i}`, `setUp() reverted: ArmBDeployer stub missing at 0x${i}${i}${i} [256 runs]`));
    const p = detectMaskedMonolith(nine);
    expect(p.masked).toBe(true);
    expect(p.sharedCount).toBe(9);
    expect(p.syntheticTarget).toContain("resolve the shared failure");
    expect(p.reason).toContain("not halting");
  });

  it("does NOT flag a real gradient — many distinct roots", () => {
    const mixed = [
      fail("a", "AssertionError: export set mismatch"),
      fail("b", "AssertionError: uses ambient clock"),
      fail("c", "AssertionError: strict mode off"),
      fail("d", "AssertionError: dependency not @noble"),
    ];
    expect(detectMaskedMonolith(mixed).masked).toBe(false);
  });

  it("does not fire on a nearly-solved suite (one straggler left)", () => {
    const results: FailedTest[] = [
      { id: "p1", status: "passed" }, { id: "p2", status: "passed" },
      fail("x", "AssertionError: last one"),
    ];
    expect(detectMaskedMonolith(results).masked).toBe(false); // below minTests failing
  });

  it("a partial mask below threshold reads as a (weak) gradient, not a monolith", () => {
    const results = [
      fail("a", "setUp() reverted: stub"), fail("b", "setUp() reverted: stub"),
      fail("c", "AssertionError: real"), fail("d", "AssertionError: other"), fail("e", "AssertionError: third"),
    ];
    // 2/5 share a root — under 0.8, so climb the gradient rather than peel.
    expect(detectMaskedMonolith(results).masked).toBe(false);
  });

  it("recursion-ready: after peeling, a remaining sub-mask is detectable on its own subset", () => {
    const remainder = Array.from({ length: 4 }, (_, i) => fail(`u${i}`, "revert: pool not initialized"));
    const p = detectMaskedMonolith(remainder);
    expect(p.masked).toBe(true);
    expect(p.sharedRoot).toContain("pool not initialized");
  });
});

describe("peelTargetPrompt", () => {
  it("frames the rung as diagnostic and forbids stubbing the shared component", () => {
    const p = detectMaskedMonolith(Array.from({ length: 5 }, (_, i) => fail(`t${i}`, "setUp() reverted: X")));
    const prompt = peelTargetPrompt(p);
    expect(prompt).toContain("not a requirement");
    expect(prompt).toContain("Do NOT weaken or stub");
    expect(prompt).toContain("report independently");
  });
});

describe("peelIsStandaloneCheckpoint", () => {
  it("records the greens when the wall fell AND tests flipped in the same turn", () => {
    // The peel2 fixture: one write dissolved the mask and greened all four.
    // Short-circuiting here is what made brew report 0/4 on a passing suite.
    expect(peelIsStandaloneCheckpoint(true, 4)).toBe(false);
  });
  it("is a checkpoint on its own when the wall fell but nothing greened yet", () => {
    expect(peelIsStandaloneCheckpoint(true, 0)).toBe(true);
  });
  it("never fires when no peel was resolved", () => {
    expect(peelIsStandaloneCheckpoint(false, 0)).toBe(false);
  });
});

describe("diagnoseToolFailure", () => {
  // The ladder-fixture run: write_file could not create a directory, and brew
  // called it ITERATION_CAP after $2.27.
  const enoent = (p: string) => ({ tool: "write_file", message: `ENOENT: no such file or directory, open '/repo/${p}/probe.txt'` });

  it("names the broken tool when one error root dominates its calls", () => {
    const d = diagnoseToolFailure([enoent("src"), enoent("lib"), enoent("app"), enoent("zzz")], 8);
    expect(d.failing).toBe(true);
    expect(d.tool).toBe("write_file");
    expect(d.reason).toContain("not an agent stall");
    expect(d.reason).toContain("ENOENT");
  });

  it("ignores incidental errors — a couple of misses is normal exploration", () => {
    expect(diagnoseToolFailure([enoent("src"), enoent("lib")], 20).failing).toBe(false);
  });

  it("does not fire when the errors are scattered across different causes", () => {
    const mixed = [
      { tool: "read_file", message: "ENOENT: missing package.json" },
      { tool: "write_file", message: "EACCES: permission denied" },
      { tool: "find_references", message: "no matches for calc" },
      { tool: "read_file", message: "ENOENT: missing tsconfig" },
    ];
    expect(diagnoseToolFailure(mixed, 10).failing).toBe(false);
  });

  it("stays quiet when the tool errors are a small share of a busy turn", () => {
    const many = [enoent("a"), enoent("b"), enoent("c")];
    expect(diagnoseToolFailure(many, 40).failing).toBe(false);   // 3/40 = 7.5%
    expect(diagnoseToolFailure(many, 6).failing).toBe(true);     // 3/6  = 50%
  });
});

describe("peelResolved", () => {
  const masked = (root: string, n: number) => ({ masked: true, sharedRoot: root, sharedCount: n, reason: "" });
  const clear = { masked: false, sharedRoot: "", sharedCount: 0, reason: "" };

  it("resolved when the mask is gone — the gradient unmasked", () => {
    expect(peelResolved(masked("deploy reverts", 9), clear)).toBe(true);
  });
  it("resolved when the root CHANGED — the old wall fell, recurse onto the new one", () => {
    expect(peelResolved(masked("deploy reverts", 9), masked("pool not initialized", 4))).toBe(true);
  });
  it("resolved when the mask fragmented to half or less", () => {
    expect(peelResolved(masked("deploy reverts", 9), masked("deploy reverts", 4))).toBe(true);
    expect(peelResolved(masked("deploy reverts", 9), masked("deploy reverts", 8))).toBe(false);
  });
  it("never resolved when there was no mask to begin with", () => {
    expect(peelResolved(clear, clear)).toBe(false);
  });
});
