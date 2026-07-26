// The journeys artifact: schema round-trip + walk enumeration + prefix math.
// Fixtures are deliberately domain-neutral — the transition serves ANY
// wireframe → ANY mock (a generic tasks app here, never a specific product).
import { describe, it, expect } from "vitest";
import { JourneysFileSchema, listWalks, walkId, walkSteps, type Journey } from "./journeys-schema.js";

const journey: Journey = {
  id: "first-run",
  epic: "Onboarding",
  persona: "member",
  title: "A new member signs up and creates their first task",
  start_world: "empty",
  red_route_rank: 1,
  source: { kind: "authored" },
  steps: [
    { id: "s1", text: "Opens the app for the first time", route: "/", action: "goto", expect: [] },
    {
      id: "s2", text: "Creates the first task", route: "/", action: "click", affordance: "add-task",
      expect: [{ kind: "query", expr: "window.__slowcook.data.listTasks().then(t=>t.length===1)", world_sensitive: true }],
      branches: [
        {
          id: "empty-title", given: "the title field is left empty",
          steps: [
            { id: "b1", text: "Sees the validation notice", route: "/", action: "click", affordance: "save-task", expect: [{ kind: "dom", expr: "!!document.querySelector('[role=\"alert\"]')" }] },
          ],
        },
      ],
    },
    { id: "s3", text: "Marks it done", route: "/", action: "click", affordance: "complete-task", destructive: false, expect: [{ kind: "query", expr: "window.__slowcook.data.listTasks().then(t=>t[0].done)" }] },
  ],
};

describe("journeys schema", () => {
  it("round-trips a valid file", () => {
    const parsed = JourneysFileSchema.parse({ schema_version: 1, journeys: [journey] });
    expect(parsed.journeys[0]!.steps[1]!.branches![0]!.given).toContain("empty");
  });

  it("rejects an interaction pointing at nothing (schema-level id rules)", () => {
    const bad = JSON.parse(JSON.stringify(journey)) as Journey;
    (bad.steps[0] as { id: string }).id = "Bad Step!";
    expect(JourneysFileSchema.safeParse({ schema_version: 1, journeys: [bad] }).success).toBe(false);
  });

  it("enumerates walks: main + every branch at any depth", () => {
    const walks = listWalks(journey);
    expect(walks.map((w) => w.walkId)).toEqual([walkId("first-run", null), walkId("first-run", "empty-title")]);
  });

  it("walkSteps: a branch walk shares the prefix through the branching step", () => {
    const steps = walkSteps(journey, "empty-title");
    expect(steps.map((s) => s.id)).toEqual(["s1", "s2", "b1"]);
  });

  it("walkSteps: sibling branches do not pollute each other's prefixes", () => {
    const j2 = JSON.parse(JSON.stringify(journey)) as Journey;
    j2.steps[2]!.branches = [{ id: "undo", given: "the member changes their mind", steps: [{ id: "u1", text: "Restores the task", route: "/", action: "click", affordance: "undo-complete", expect: [{ kind: "dom", expr: "true" }] }] }];
    expect(walkSteps(j2, "undo").map((s) => s.id)).toEqual(["s1", "s2", "s3", "u1"]);
    expect(walkSteps(j2, "empty-title").map((s) => s.id)).toEqual(["s1", "s2", "b1"]);
  });
});
