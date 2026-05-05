import { describe, it, expect } from "vitest";
import type { ChefOrchestrateVerdict } from "@slowcook-ai/llm-anthropic";
import { validateVerdictShape } from "./orchestrate.js";

describe("validateVerdictShape", () => {
  it("accepts a valid escalate verdict", () => {
    const v: ChefOrchestrateVerdict = {
      kind: "escalate",
      rationale: "chef-drift tried 2 fixes, both reverted; PM needs to redirect",
      action: {
        issue_number: 149,
        label: "chef:escalate",
        comment: "Escalating PR #153 — failing tests describe a feature brew can't synthesize.",
      },
    };
    expect(() => validateVerdictShape(v)).not.toThrow();
  });

  it("accepts a valid close verdict", () => {
    const v: ChefOrchestrateVerdict = {
      kind: "close",
      rationale: "Superseded by PR #154 which is green and merged to main",
      action: { reason: "superseded by #154", comment: "Closing — see PR #154." },
    };
    expect(() => validateVerdictShape(v)).not.toThrow();
  });

  it("accepts a valid rebase verdict", () => {
    const v: ChefOrchestrateVerdict = {
      kind: "rebase",
      rationale: "PR is BEHIND main; needs rebase before any retry can be meaningful",
      action: { onto: "origin/main", expected_conflict_paths: ["specs/_index.yaml"] },
    };
    expect(() => validateVerdictShape(v)).not.toThrow();
  });

  it("accepts a valid redispatch_brew verdict", () => {
    const v: ChefOrchestrateVerdict = {
      kind: "redispatch_brew",
      rationale: "chef-drift had 0 reverts; navigator history shows progress; transient halt",
      action: {
        brew_workflow: "slowcook-brew.yml",
        additional_context: "Prior chef move addressed the route arithmetic; brew should retry from there.",
      },
    };
    expect(() => validateVerdictShape(v)).not.toThrow();
  });

  it("rejects a verdict missing kind", () => {
    const v = { rationale: "x", action: {} } as unknown as ChefOrchestrateVerdict;
    expect(() => validateVerdictShape(v)).toThrow(/missing kind/);
  });

  it("rejects an escalate verdict with non-numeric issue_number", () => {
    const v = {
      kind: "escalate",
      rationale: "x",
      action: { issue_number: "149", label: "chef:escalate", comment: "..." },
    } as unknown as ChefOrchestrateVerdict;
    expect(() => validateVerdictShape(v)).toThrow(/issue_number:number/);
  });

  it("rejects a rebase verdict with non-array expected_conflict_paths", () => {
    const v = {
      kind: "rebase",
      rationale: "x",
      action: { onto: "origin/main", expected_conflict_paths: "specs/_index.yaml" },
    } as unknown as ChefOrchestrateVerdict;
    expect(() => validateVerdictShape(v)).toThrow(/expected_conflict_paths/);
  });

  it("rejects a close verdict missing comment", () => {
    const v = {
      kind: "close",
      rationale: "x",
      action: { reason: "superseded by #154" },
    } as unknown as ChefOrchestrateVerdict;
    expect(() => validateVerdictShape(v)).toThrow(/reason:string \+ comment:string/);
  });

  it("rejects an unknown verdict kind", () => {
    const v = {
      kind: "ghostbust",
      rationale: "x",
      action: {},
    } as unknown as ChefOrchestrateVerdict;
    expect(() => validateVerdictShape(v)).toThrow(/unknown verdict kind/);
  });

  it("rejects a redispatch_brew verdict missing additional_context", () => {
    const v = {
      kind: "redispatch_brew",
      rationale: "x",
      action: { brew_workflow: "slowcook-brew.yml" },
    } as unknown as ChefOrchestrateVerdict;
    expect(() => validateVerdictShape(v)).toThrow(/brew_workflow \+ additional_context/);
  });
});
