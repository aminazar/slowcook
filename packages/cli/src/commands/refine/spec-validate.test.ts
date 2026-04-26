import { describe, it, expect } from "vitest";
import { validateAndRepairSpec } from "./spec-validate.js";
import type { Spec } from "@slowcook-ai/core";

function baseSpec(extra: Partial<Spec> = {}): Spec {
  return {
    story_id: "1",
    title: "test",
    status: "active",
    created_at: "2026-04-26T00:00:00Z",
    supersedes: [],
    superseded_by: null,
    actors: [],
    preconditions: [],
    invariants: [],
    acceptance_scenarios: [],
    non_goals: [],
    ...extra,
  };
}

describe("validateAndRepairSpec — token list pruning", () => {
  it("drops unterminated var() entries (BUG-E regression: story-016 var(--tint-in)", () => {
    const spec = baseSpec({
      proposals: {
        ui_layout: {
          status: "pending",
          proposed_by: "refine-agent",
          tokens_to_reuse: [
            "var(--coral)",
            "var(--tint-celebrate)",
            "var(--tint-in", // truncated
          ],
        },
      },
    });
    const findings = validateAndRepairSpec(spec);
    expect(spec.proposals?.ui_layout?.tokens_to_reuse).toEqual([
      "var(--coral)",
      "var(--tint-celebrate)",
    ]);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.action).toBe("dropped");
    expect(findings[0]!.message).toContain("Unterminated var()");
    expect(findings[0]!.path).toBe("proposals.ui_layout.tokens_to_reuse[2]");
  });

  it("drops empty + non-string entries", () => {
    const spec = baseSpec({
      proposals: {
        ui_layout: {
          status: "pending",
          proposed_by: "refine-agent",
          tokens_to_reuse: ["bg-coral", "", "  ", null as unknown as string],
        },
      },
    });
    const findings = validateAndRepairSpec(spec);
    expect(spec.proposals?.ui_layout?.tokens_to_reuse).toEqual(["bg-coral"]);
    expect(findings).toHaveLength(3);
    expect(findings.every((f) => f.action === "dropped")).toBe(true);
  });

  it("drops class-prefix-only tokens (`bg-`, `text-`)", () => {
    const spec = baseSpec({
      proposals: {
        ui_layout: {
          status: "pending",
          proposed_by: "refine-agent",
          tokens_to_reuse: ["bg-coral", "bg-", "text-", "text-foreground"],
        },
      },
    });
    const findings = validateAndRepairSpec(spec);
    expect(spec.proposals?.ui_layout?.tokens_to_reuse).toEqual([
      "bg-coral",
      "text-foreground",
    ]);
    expect(findings.every((f) => f.message.includes("Class-prefix-only"))).toBe(true);
  });

  it("returns empty findings for a clean spec", () => {
    const spec = baseSpec({
      proposals: {
        ui_layout: {
          status: "pending",
          proposed_by: "refine-agent",
          tokens_to_reuse: ["bg-coral", "var(--tint-celebrate)"],
          components_to_reuse: ["src/components/RewoCard.tsx"],
        },
      },
    });
    const findings = validateAndRepairSpec(spec);
    expect(findings).toEqual([]);
  });

  it("works on tokens_to_add too", () => {
    const spec = baseSpec({
      proposals: {
        ui_layout: {
          status: "pending",
          proposed_by: "refine-agent",
          tokens_to_add: ["bg-mauve", "var(--invented"],
        },
      },
    });
    const findings = validateAndRepairSpec(spec);
    expect(spec.proposals?.ui_layout?.tokens_to_add).toEqual(["bg-mauve"]);
    expect(findings[0]!.path).toBe("proposals.ui_layout.tokens_to_add[1]");
  });

  it("no-op when no proposals.ui_layout", () => {
    const spec = baseSpec();
    const findings = validateAndRepairSpec(spec);
    expect(findings).toEqual([]);
  });
});
