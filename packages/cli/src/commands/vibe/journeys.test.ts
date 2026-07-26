// The deterministic concept→journeys compiler: mapping + gap detection.
// Domain-neutral fixture (a generic notes product).
import { describe, it, expect } from "vitest";
import { compileFromConcept } from "./journeys.js";

const concept = {
  personas: [{ id: "member" }],
  screens: [
    { id: "home", route: "/" },
    { id: "notes", route: "/notes" },
    { id: "unrouted-screen" },
  ],
  journeys: [
    {
      id: "capture-a-note",
      rank: 1,
      persona: "member",
      story: "A member captures a note and finds it again",
      steps: [
        { text: "Opens the app", screen: "home" },
        { text: "Creates a note", screen: "notes", action: "click", affordance: "add-note", expect: [{ kind: "query", expr: "window.__slowcook.data.listNotes().then(n=>n.length===1)" }] },
        { text: "Deletes the note", screen: "notes", action: "click", affordance: "delete-note" },
      ],
    },
    {
      id: "orphan-journey",
      rank: 2,
      steps: [{ text: "Opens the unrouted screen", screen: "unrouted-screen" }],
    },
  ],
};

describe("compileFromConcept", () => {
  const { file, gaps, stats } = compileFromConcept(concept as never, "concept.yaml");

  it("maps journeys, screens→routes, ranks, and sources", () => {
    const j = file.journeys[0]!;
    expect(j.persona).toBe("member");
    expect(j.red_route_rank).toBe(1);
    expect(j.steps[1]!.route).toBe("/notes");
    expect(j.source.ref).toContain("#journeys/capture-a-note");
  });

  it("flags a missing persona as a concept gap", () => {
    expect(gaps.some((g) => g.summary.includes('"orphan-journey" has no persona'))).toBe(true);
  });

  it("flags a screen without a route", () => {
    expect(gaps.some((g) => g.summary.includes('"unrouted-screen" has no route'))).toBe(true);
  });

  it("flags an interaction without acceptance expects (law 5)", () => {
    expect(gaps.some((g) => g.summary.includes("no acceptance expects") && g.summary.includes("s3"))).toBe(true);
  });

  it("counts executable steps only when fully specified", () => {
    expect(stats.executableSteps).toBe(1); // add-note has expects; delete-note lacks them
  });

  it("every gap targets the concept", () => {
    expect(gaps.every((g) => g.target === "concept")).toBe(true);
  });
});
