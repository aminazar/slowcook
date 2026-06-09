import { describe, it, expect } from "vitest";
import { assembleStories, type AssembleOptions } from "./assemble.js";
import type { MenuStoryDraft } from "@slowcook-ai/llm-anthropic";

const draft = (over: Partial<MenuStoryDraft> = {}): MenuStoryDraft => ({
  title: "Browse therapists",
  prd_anchor: "onboarding",
  estimate: "medium",
  actors: [{ name: "patient" }],
  invariants: ["only verified therapists shown"],
  data_contract: {
    entities: [{ name: "Therapist", fields: [{ name: "id", type: "uuid" }] }],
    api: [{ method: "GET", path: "/therapists" }],
  },
  fidelity_modes: ["light", "dark", "mobile"],
  acceptance_scenarios: ["Given x When y Then z", "validation", "edge"],
  non_goals: ["booking"],
  open_questions: { addressable: ["sort order?"], deferred: [] },
  ...over,
});

const opts: AssembleOptions = {
  prdFile: "docs/PRD.md",
  startId: 7,
  now: "2026-06-09T00:00:00.000Z",
  cliVersion: "0.20.0",
};

describe("assembleStories", () => {
  it("assigns zero-padded sequential ids from startId", () => {
    const { specs } = assembleStories([draft(), draft({ title: "B" })], opts);
    expect(specs.map((s) => s.story_id)).toEqual(["007", "008"]);
  });

  it("anchors each spec back to the PRD initiative", () => {
    const { specs } = assembleStories([draft()], opts);
    expect(specs[0]!.prd_ref).toEqual({ file: "docs/PRD.md", anchor: "onboarding" });
  });

  it("carries the data contract, fidelity modes, and open questions through", () => {
    const { specs } = assembleStories([draft()], opts);
    expect(specs[0]!.data_contract!.entities![0]!.name).toBe("Therapist");
    expect(specs[0]!.fidelity).toEqual({ modes: ["light", "dark", "mobile"] });
    expect(specs[0]!.open_questions).toEqual({ addressable: ["sort order?"], deferred: [] });
  });

  it("sets the required spec scaffolding (status/created_at/supersedes/refined_by)", () => {
    const { specs } = assembleStories([draft()], opts);
    expect(specs[0]).toMatchObject({
      status: "active",
      created_at: "2026-06-09T00:00:00.000Z",
      supersedes: [],
      superseded_by: null,
      refined_by: "slowcook-menu@0.20.0",
    });
  });

  it("flags a draft whose prd_anchor isn't a real initiative (provenance gap)", () => {
    const { unanchored } = assembleStories(
      [draft({ prd_anchor: "onboarding" }), draft({ title: "Ghost", prd_anchor: "does-not-exist" })],
      { ...opts, validAnchors: ["onboarding", "dashboard"] },
    );
    expect(unanchored).toEqual([{ title: "Ghost", prd_anchor: "does-not-exist" }]);
  });

  it("omits fidelity/ui_behavior when empty (additive, not noise)", () => {
    const { specs } = assembleStories([draft({ fidelity_modes: [], ui_behavior: {} })], opts);
    expect(specs[0]!.fidelity).toBeUndefined();
    expect(specs[0]!.ui_behavior).toBeUndefined();
  });
});
