import { describe, it, expect } from "vitest";
import { compileLcrPlan, parseGwt, type PlanSpecInput } from "./lcr-plan.js";

describe("compileLcrPlan — data model", () => {
  it("merges the same entity across stories, unioning fields + tracking provenance", () => {
    const specs: PlanSpecInput[] = [
      { storyId: "007", entities: [{ name: "Wallet", fields: [{ name: "id", type: "uuid" }, { name: "balance", type: "integer" }] }] },
      { storyId: "008", entities: [{ name: "Wallet", fields: [{ name: "id", type: "uuid" }, { name: "currency", type: "string" }] }] },
    ];
    const plan = compileLcrPlan(specs);
    expect(plan.entities).toHaveLength(1);
    const w = plan.entities[0]!;
    expect(w.name).toBe("Wallet");
    expect(w.fields.map((f) => f.name).sort()).toEqual(["balance", "currency", "id"]);
    expect(w.fromStories).toEqual(["007", "008"]);
    expect(w.fields.find((f) => f.name === "id")!.fromStories).toEqual(["007", "008"]);
    expect(w.fields.find((f) => f.name === "balance")!.fromStories).toEqual(["007"]);
    expect(plan.conflicts).toHaveLength(0);
  });

  it("flags a field declared with divergent types across stories", () => {
    const specs: PlanSpecInput[] = [
      { storyId: "001", entities: [{ name: "Project", fields: [{ name: "id", type: "uuid" }] }] },
      { storyId: "002", entities: [{ name: "Project", fields: [{ name: "id", type: "integer" }] }] },
    ];
    const plan = compileLcrPlan(specs);
    expect(plan.conflicts).toEqual([
      { entity: "Project", field: "id", types: [{ type: "uuid", stories: ["001"] }, { type: "integer", stories: ["002"] }] },
    ]);
  });

  it("unions relations across stories", () => {
    const specs: PlanSpecInput[] = [
      { storyId: "001", entities: [{ name: "Ticket", fields: [], relations: ["project_id → Project.id"] }] },
      { storyId: "002", entities: [{ name: "Ticket", fields: [], relations: ["reporter_id → Member.id", "project_id → Project.id"] }] },
    ];
    const plan = compileLcrPlan(specs);
    expect(plan.entities[0]!.relations.sort()).toEqual(["project_id → Project.id", "reporter_id → Member.id"]);
  });
});

describe("compileLcrPlan — personas + surfaces", () => {
  it("derives personas from the persona block when present, actors as fallback", () => {
    const specs: PlanSpecInput[] = [
      { storyId: "019", entities: [], persona: { id: "operator", chrome: "admin" }, surfaces: [{ route: "/operator", home: true }] },
      { storyId: "001", entities: [], actors: [{ name: "Founder" }] }, // no persona block → fallback
    ];
    const plan = compileLcrPlan(specs);
    const ids = plan.personas.map((p) => p.id).sort();
    expect(ids).toEqual(["Founder", "operator"]);
    expect(plan.personas.find((p) => p.id === "operator")!.chrome).toBe("admin");
  });

  it("collects surfaces with persona defaulting to the story's persona", () => {
    const specs: PlanSpecInput[] = [
      { storyId: "019", entities: [], persona: { id: "operator" }, surfaces: [{ route: "/operator/workers", states: ["empty", "populated"] }] },
    ];
    const plan = compileLcrPlan(specs);
    expect(plan.surfaces).toEqual([
      { route: "/operator/workers", persona: "operator", storyId: "019", home: false, states: ["empty", "populated"] },
    ]);
  });

  it("reports stories with no surface as uncovered (UI gap or backend-only)", () => {
    const specs: PlanSpecInput[] = [
      { storyId: "013", entities: [], persona: { id: "pm" }, surfaces: [{ route: "/board", home: true }] },
      { storyId: "021", entities: [{ name: "ReviewSurface", fields: [] }] }, // backend-only, no surface
    ];
    const plan = compileLcrPlan(specs);
    expect(plan.uncoveredStories).toEqual(["021"]);
    expect(plan.stories.find((s) => s.storyId === "013")!.hasSurface).toBe(true);
    expect(plan.stories.find((s) => s.storyId === "021")!.hasSurface).toBe(false);
  });

  it("is empty-safe", () => {
    expect(compileLcrPlan([])).toEqual({ entities: [], conflicts: [], personas: [], surfaces: [], stories: [], uncoveredStories: [], epss: [] });
  });
});

describe("parseGwt", () => {
  it("splits a Given/When/Then scenario into its three clauses, trimming trailing punctuation", () => {
    expect(parseGwt("Given a guest on /signin, When they request a code, Then an OtpCode is sent.")).toEqual({
      given: "a guest on /signin",
      when: "they request a code",
      then: "an OtpCode is sent",
    });
  });
  it("returns null for a non-Gherkin scenario", () => {
    expect(parseGwt("the wallet should never go negative")).toBeNull();
  });
});

describe("compileLcrPlan — EPSS test matrix", () => {
  it("builds an EPSS case per acceptance_scenario: epic + persona + scenario(When) + state(Given) + route(start)", () => {
    const specs: PlanSpecInput[] = [
      {
        storyId: "025",
        entities: [],
        epic: "Authentication",
        persona: { id: "guest" },
        surfaces: [{ route: "/signin", home: true }],
        acceptanceScenarios: [
          "Given a guest on /signin, When they request a code, Then a code is sent",
          "Given a guest who requested a code, When they enter it correctly, Then they are signed in",
        ],
      },
    ];
    const plan = compileLcrPlan(specs);
    expect(plan.epss).toHaveLength(2);
    expect(plan.epss[0]).toEqual({
      epic: "Authentication",
      persona: "guest",
      scenario: "they request a code",
      state: "a guest on /signin",
      then: "a code is sent",
      route: "/signin",
      storyId: "025",
    });
    // the route is the START surface (home), shared across both scenarios — it is an
    // attribute, not the scenario's identity.
    expect(plan.epss.map((e) => e.route)).toEqual(["/signin", "/signin"]);
  });

  it("skips backend-only stories (no surface → no EPSS test case)", () => {
    const plan = compileLcrPlan([
      { storyId: "030", entities: [], epic: "Audit", acceptanceScenarios: ["Given x, When y, Then z"] },
    ]);
    expect(plan.epss).toHaveLength(0);
  });
});
