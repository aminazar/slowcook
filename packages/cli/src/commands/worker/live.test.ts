import { describe, it, expect } from "vitest";
import { mapRefineOutcome, mapLiveOutcome, commentHeader } from "./live.js";

describe("mapRefineOutcome", () => {
  it("nonzero exit is failed and terminal", () => {
    const o = mapRefineOutcome(2, "");
    expect(o.outcome).toBe("failed");
    expect(o.resultLabel).toBe("agent:failed");
  });

  it("spec-emitted (Draft PR line) is the only path to agent:refined", () => {
    const o = mapRefineOutcome(
      0,
      "Spec written: specs/story-034.yaml\nDraft PR: https://github.com/reworthy/app/pull/999\n"
    );
    expect(o.outcome).toBe("success");
    expect(o.resultLabel).toBe("agent:refined");
    expect(o.artifacts).toEqual([
      "https://github.com/reworthy/app/pull/999",
      "specs/story-034.yaml",
    ]);
  });

  it("exit 0 without a spec applies NO label — refine paused for a human", () => {
    const o = mapRefineOutcome(0, "Posted clarifying questions (comment 42). Awaiting PM reply.\n");
    expect(o.outcome).toBe("success");
    expect(o.resultLabel).toBeNull();
    expect(o.artifacts).toEqual([]);
    expect(o.detail).toContain("non-terminal");
  });

  it("an amended spec (resubmit) is success with no label — the PR is the state", () => {
    const o = mapRefineOutcome(
      0,
      "Spec amended: /root/rewo/specs/story-019.yaml\nPushed to branch slowcook/spec/story-019.\n"
    );
    expect(o.outcome).toBe("success");
    expect(o.resultLabel).toBeNull();
    expect(o.artifacts).toEqual([
      "/root/rewo/specs/story-019.yaml",
      "slowcook/spec/story-019",
    ]);
    expect(o.detail).toContain("amended");
  });

  it("an executed split advances the chain onto the sub-issues", () => {
    const o = mapRefineOutcome(0, "Split executed: #45 #46 #47 (1 overlap skipped)\n");
    expect(o.outcome).toBe("success");
    expect(o.resultLabel).toBeNull();
    expect(o.advanceIssues).toEqual([45, 46, 47]);
    expect(o.artifacts).toEqual(["#45", "#46", "#47"]);
  });

  it("a Noop line is reported as a no-op, never as questions-posted", () => {
    const o = mapRefineOutcome(
      0,
      "models:\n  refine claude-opus-4-8\nNoop: issue is not labeled needs-refinement (precondition waived by --no-require-label).\n"
    );
    expect(o.outcome).toBe("success");
    expect(o.resultLabel).toBeNull();
    expect(o.detail).toContain("no-op");
    expect(o.detail).toContain("needs-refinement");
  });

  it("a Draft PR mention mid-line does not count as spec-emitted", () => {
    const o = mapRefineOutcome(0, "see the old Draft PR: https://x/pull/1 for context\n");
    expect(o.resultLabel).toBeNull();
  });
});

describe("mapLiveOutcome", () => {
  it("stages beyond refine fail closed rather than pretending", () => {
    const o = mapLiveOutcome("brew", 0, "all green");
    expect(o.outcome).toBe("failed");
    expect(o.detail).toContain("W1");
  });
});

describe("commentHeader", () => {
  it("carries agent, issue, and run id for trace correlation", () => {
    expect(commentHeader("refine", 34, "run-x")).toBe("**slowcook-refine** · issue #34 · run run-x");
  });
});
