import { describe, it, expect } from "vitest";
import { parseAgentOutput, stripModelEmittedDuplicates } from "./agent.js";

const CTX = {
  storyId: "042",
  issueNumber: 15,
  createdAt: "2026-04-20T12:00:00.000Z",
  cliVersion: "0.4.0",
  supersedes: [],
};

const VALID_YAML = `
title: Member can react to a rewo with an emotion
actors:
  - name: authenticated_member
preconditions:
  - Member has reactions remaining this week
invariants:
  - Weekly ration never exceeds 15
acceptance_scenarios:
  - "Given 14/15, when react, then 15/15"
  - "Given 15/15, when react, then 429"
  - "Given own rewo, when react, then UI prevents"
non_goals:
  - Editing an existing reaction
`;

describe("parseAgentOutput", () => {
  it("detects a question round from plain markdown", () => {
    const raw = `Got it — your issue describes a reaction flow. A few questions:

1. What happens when a user reaches exactly 15 reactions?
2. Can a user react to their own rewo?
3. What's the reset window?

Please answer inline.`;
    const out = parseAgentOutput(raw, CTX);
    expect(out.kind).toBe("questions");
    if (out.kind === "questions") expect(out.markdown).toContain("1.");
  });

  it("parses a YAML spec from a ```yaml fence", () => {
    const raw = "```yaml\n" + VALID_YAML + "\n```";
    const out = parseAgentOutput(raw, CTX);
    expect(out.kind).toBe("spec");
    if (out.kind === "spec") {
      expect(out.spec.story_id).toBe("042");
      expect(out.spec.source_issue).toBe("#15");
      expect(out.spec.refined_by).toBe("slowcook-refine@0.4.0");
      expect(out.spec.status).toBe("active");
      expect(out.spec.actors).toHaveLength(1);
    }
  });

  it("parses a bare YAML document starting with ---", () => {
    const raw = "---\n" + VALID_YAML.trim();
    const out = parseAgentOutput(raw, CTX);
    expect(out.kind).toBe("spec");
  });

  it("parses YAML without fences if it has the key signals", () => {
    const raw = VALID_YAML.trim();
    const out = parseAgentOutput(raw, CTX);
    expect(out.kind).toBe("spec");
  });

  it("defaults missing required-array fields instead of throwing (α.27 change)", () => {
    // Was a throw-on-missing test pre-α.27. Now the missing arrays
    // (preconditions, invariants, non_goals) default to [] so the
    // PM doesn't lose work to a silent crash.
    const yaml = `---
title: missing required fields
actors:
  - name: x
acceptance_scenarios:
  - scenario-one
`;
    const out = parseAgentOutput(yaml, CTX);
    expect(out.kind).toBe("spec");
    if (out.kind === "spec") {
      expect(out.spec.preconditions).toEqual([]);
      expect(out.spec.invariants).toEqual([]);
      expect(out.spec.non_goals).toEqual([]);
    }
  });

  it("supersedes field is taken from the provided context, not the agent's output", () => {
    const raw = "```yaml\n" + VALID_YAML + "\n```";
    const out = parseAgentOutput(raw, {
      ...CTX,
      supersedes: ["007", "012"],
    });
    expect(out.kind).toBe("spec");
    if (out.kind === "spec") {
      expect(out.spec.supersedes).toEqual(["007", "012"]);
    }
  });

  it("empty output triggers an explicit error (not silent questions)", () => {
    expect(() => parseAgentOutput("", CTX)).toThrow(/empty/);
  });

  it("defaults missing non_goals to [] instead of crashing (delgoosh#635 round 6 fix)", () => {
    const yamlWithoutNonGoals = `---
title: Test story
actors:
  - name: user
preconditions:
  - X
invariants:
  - Y
acceptance_scenarios:
  - Z
`;
    const out = parseAgentOutput(yamlWithoutNonGoals, CTX);
    expect(out.kind).toBe("spec");
    if (out.kind === "spec") {
      expect(out.spec.non_goals).toEqual([]);
    }
  });

  it("defaults ALL required-array fields when the LLM forgets multiple", () => {
    const yamlMinimal = `---
title: Bare-minimum spec
`;
    const out = parseAgentOutput(yamlMinimal, CTX);
    expect(out.kind).toBe("spec");
    if (out.kind === "spec") {
      expect(out.spec.actors).toEqual([]);
      expect(out.spec.preconditions).toEqual([]);
      expect(out.spec.invariants).toEqual([]);
      expect(out.spec.acceptance_scenarios).toEqual([]);
      expect(out.spec.non_goals).toEqual([]);
    }
  });
});

describe("stripModelEmittedDuplicates — defense in depth for cost-footer/brand-header copying", () => {
  it("strips the brand header at the top of model output", () => {
    const body = "### slowcook · refinement agent 🍲\n\nLocked in: foo bar.\n";
    expect(stripModelEmittedDuplicates(body)).toBe("Locked in: foo bar.");
  });

  it("strips a cost footer the model copied from prior context", () => {
    const body =
      "Locked in: foo.\n\n---\n<sub>💰 **This step:** $0.97 · **Story total:** $0.97 (1 agent call so far)</sub>";
    expect(stripModelEmittedDuplicates(body)).toBe("Locked in: foo.");
  });

  it("strips an HTML cost marker the model copied", () => {
    const body =
      "Locked in: foo.\n\n<!-- slowcook:cost agent=refine usd=0.9670 tokens_in=4084 -->";
    expect(stripModelEmittedDuplicates(body)).toBe("Locked in: foo.");
  });

  it("strips all three (brand header + footer + marker) when model copies the full prior turn", () => {
    const body =
      "### slowcook · refinement agent 🍲\n\nNew round content here.\n\n" +
      "---\n<sub>💰 **This step:** $0.50 · **Story total:** $1.00 (2 agent calls so far)</sub>\n\n" +
      "<!-- slowcook:cost agent=refine usd=0.5000 -->";
    expect(stripModelEmittedDuplicates(body)).toBe("New round content here.");
  });

  it("no-op on clean model output", () => {
    const body = "Real refine output with no copied patterns. Bullets:\n- one\n- two";
    expect(stripModelEmittedDuplicates(body)).toBe(body);
  });
});

// ── sc#236 root-cause regression: repo-local fields survive the Spec rebuild ──
describe("parseAgentOutput repo-local passthrough", () => {
  it("keeps prd_ref/epic emitted by the model through the hand rebuild", () => {
    const yaml = [
      "---",
      "title: t",
      'estimate: small',
      "actors: []",
      "preconditions: []",
      "invariants: [inv]",
      "acceptance_scenarios: ['Given a, When b, Then c', 'Given d, When e, Then f', 'Given g, When h, Then i']",
      "non_goals: []",
      'epic: "Backend"',
      "prd_ref:",
      "  file: docs/PRD.md",
      "  anchor: surface-billing",
    ].join("\n");
    const out = parseAgentOutput(yaml, {
      storyId: "099",
      issueNumber: 1,
      createdAt: "2026-07-03T00:00:00.000Z",
      supersedes: [],
      cliVersion: "0.0.0-test",
    } as never);
    expect(out.kind).toBe("spec");
    if (out.kind === "spec") {
      const s = out.spec as unknown as Record<string, unknown>;
      expect(s.epic).toBe("Backend");
      expect(s.prd_ref).toEqual({ file: "docs/PRD.md", anchor: "surface-billing" });
      expect(s.story_id).toBe("099"); // enumerated fields still win
    }
  });
});
