import { describe, it, expect } from "vitest";
import {
  DEFAULT_GATES,
  isGateSatisfied,
  type Gate,
  type Approval,
} from "./model.js";
import type { ReviewersConfig } from "./reviewers.js";

const REFINE_GATE: Gate = DEFAULT_GATES.find((g) => g.stage === "refine")!;
const PLATE_GATE: Gate = DEFAULT_GATES.find((g) => g.stage === "plate")!;
const BREW_GATE: Gate = DEFAULT_GATES.find((g) => g.stage === "brew")!;

const reviewers: ReviewersConfig = {
  schema_version: 1,
  roles: {
    pm: ["aminazar"],
    designer: ["some-designer"],
    qa: ["qa-person", "another-qa"],
  },
};

function approval(
  byHandle: string,
  state: Approval["state"],
  identityType: Approval["identityType"] = "human",
): Approval {
  return { byHandle, state, identityType };
}

describe("DEFAULT_GATES", () => {
  it("wires refine→[pm], plate→[designer], brew→[qa,designer]", () => {
    expect(REFINE_GATE.requiredRoles).toEqual(["pm"]);
    expect(PLATE_GATE.requiredRoles).toEqual(["designer"]);
    expect(BREW_GATE.requiredRoles).toEqual(["qa", "designer"]);
    expect(REFINE_GATE.onRejectTarget).toBe("refine");
    expect(BREW_GATE.approvalSignal).toBe("review");
  });
});

describe("isGateSatisfied — integrity property", () => {
  it("a valid human approval from a configured pm satisfies the refine gate", () => {
    const v = isGateSatisfied(REFINE_GATE, reviewers, [approval("aminazar", "approved")]);
    expect(v.satisfied).toBe(true);
    expect(v.missingRoles).toEqual([]);
    expect(v.rejected).toBe(false);
    expect(v.reason).toBe("satisfied");
  });

  it("a BOT approval from a configured handle does NOT satisfy — bot identity is unforgeable", () => {
    const v = isGateSatisfied(REFINE_GATE, reviewers, [approval("aminazar", "approved", "bot")]);
    expect(v.satisfied).toBe(false);
    expect(v.missingRoles).toEqual(["pm"]);
    expect(v.rejected).toBe(false);
    expect(v.reason).toContain("missing pm");
  });

  it("a human approval from someone NOT in the role list does NOT satisfy", () => {
    const v = isGateSatisfied(REFINE_GATE, reviewers, [approval("random-person", "approved")]);
    expect(v.satisfied).toBe(false);
    expect(v.missingRoles).toEqual(["pm"]);
  });

  it("matches handles case-insensitively (AminAzar vs aminazar)", () => {
    const v = isGateSatisfied(REFINE_GATE, reviewers, [approval("AminAzar", "approved")]);
    expect(v.satisfied).toBe(true);
    expect(v.missingRoles).toEqual([]);
  });

  it("brew gate needs BOTH qa AND designer — only-qa is missing ['designer']", () => {
    const v = isGateSatisfied(BREW_GATE, reviewers, [approval("qa-person", "approved")]);
    expect(v.satisfied).toBe(false);
    expect(v.missingRoles).toEqual(["designer"]);
    expect(v.reason).toContain("missing designer");
  });

  it("brew gate satisfied when both qa and designer approve", () => {
    const v = isGateSatisfied(BREW_GATE, reviewers, [
      approval("another-qa", "approved"),
      approval("some-designer", "approved"),
    ]);
    expect(v.satisfied).toBe(true);
    expect(v.missingRoles).toEqual([]);
    expect(v.rejected).toBe(false);
  });

  it("a valid human rejection → rejected:true, satisfied:false even if another role approved", () => {
    const v = isGateSatisfied(BREW_GATE, reviewers, [
      approval("qa-person", "rejected"),
      approval("some-designer", "approved"),
    ]);
    expect(v.rejected).toBe(true);
    expect(v.satisfied).toBe(false);
    expect(v.reason).toContain("rejected by qa");
  });

  it("a BOT rejection does not count as a valid rejection", () => {
    const v = isGateSatisfied(REFINE_GATE, reviewers, [
      approval("aminazar", "rejected", "bot"),
    ]);
    expect(v.rejected).toBe(false);
    // still unsatisfied — no valid approval either
    expect(v.satisfied).toBe(false);
    expect(v.missingRoles).toEqual(["pm"]);
  });

  it("an empty reviewers config for a required role can never be satisfied", () => {
    const empty: ReviewersConfig = { schema_version: 1, roles: {} };
    const v = isGateSatisfied(REFINE_GATE, empty, [approval("aminazar", "approved")]);
    expect(v.satisfied).toBe(false);
    expect(v.missingRoles).toEqual(["pm"]);
  });

  it("a 'commented' signal (not approved) does not satisfy", () => {
    const v = isGateSatisfied(REFINE_GATE, reviewers, [approval("aminazar", "commented")]);
    expect(v.satisfied).toBe(false);
    expect(v.missingRoles).toEqual(["pm"]);
  });
});
