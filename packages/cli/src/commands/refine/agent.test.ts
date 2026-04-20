import { describe, it, expect } from "vitest";
import { parseAgentOutput } from "./agent.js";

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

  it("throws a clear error when YAML-shaped output fails schema", () => {
    const bad = `
title: missing required fields
actors:
  - name: x
acceptance_scenarios:
  - scenario-one
`;
    // missing preconditions, invariants, non_goals
    expect(() => parseAgentOutput(bad, CTX)).toThrow(/validation|required/);
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
});
