import { describe, it, expect } from "vitest";
import { generateLcrApp, routeToName, mockYaml, epssManifestJson } from "./app-gen.js";
import type { LcrPlan } from "./lcr-plan.js";

const plan: LcrPlan = {
  entities: [],
  conflicts: [],
  personas: [
    { id: "founder", chrome: "member", fromStories: ["001"] },
    { id: "operator", chrome: "admin", fromStories: ["017"] },
  ],
  // surfaces = WHERE (routes → pages + persona homes). They no longer define the
  // EPSS scenarios — those come from `epss` below (the acceptance-scenario test cases).
  surfaces: [
    { route: "/projects", persona: "founder", storyId: "001", home: true, states: ["empty", "populated"] },
    { route: "/projects/:projectId/wallet", persona: "founder", storyId: "004", home: false, states: ["edge"] },
    { route: "/admin/workers", persona: "operator", storyId: "017", home: true, states: ["populated"] },
    { route: "/admin/workers", persona: "operator", storyId: "017", home: true, states: ["empty"] }, // dup route, merges
  ],
  // epss = the semantic test matrix: epic ▸ persona ▸ scenario(When) ▸ state(Given).
  // The route is just where the test STARTS — one route can back many scenarios.
  epss: [
    { epic: "Founder onboarding", persona: "founder", scenario: "They add a GitHub repo", state: "No prior project", then: "the project is created", route: "/projects", storyId: "001" },
    { epic: "Founder onboarding", persona: "founder", scenario: "They open the wallet below threshold", state: "Wallet below threshold", then: "a top-up prompt shows", route: "/projects/:projectId/wallet", storyId: "004" },
    { epic: "Worker oversight", persona: "operator", scenario: "They review the worker roster", state: "Workers exist", then: "the roster lists them", route: "/admin/workers", storyId: "017" },
    // same scenario, different Given → a SECOND state on the one scenario (not a new scenario)
    { epic: "Worker oversight", persona: "operator", scenario: "They review the worker roster", state: "No workers yet", then: "an empty state shows", route: "/admin/workers", storyId: "017" },
  ],
  stories: [],
  uncoveredStories: [],
};

describe("routeToName", () => {
  it("PascalCases segments, keeps params as By<Param>, handles root", () => {
    expect(routeToName("/admin/workers")).toBe("AdminWorkersPage");
    expect(routeToName("/projects/:projectId/wallet")).toBe("ProjectsByProjectIdWalletPage");
    expect(routeToName("/")).toBe("HomePage");
    expect(routeToName("/review/:guestToken")).toBe("ReviewByGuestTokenPage");
  });
});

describe("generateLcrApp", () => {
  const files = generateLcrApp(plan, { projectName: "dash", owner: "slowcook-dev", repo: "dash" });
  const byPath = new Map(files.map((f) => [f.path, f.content]));

  it("emits the Vite scaffold + shell + shared <Async> primitive + Foundations page + EPSS manifest", () => {
    for (const p of [
      "package.json", "vite.config.ts", "src/main.tsx", "src/App.tsx", "src/shell/Shell.tsx",
      "src/review-surfaces.ts", "src/shell/useStoryMarker.ts", "public/testing-surfaces.json",
      // folded conventions: the universal-state primitive + its EPSS home
      "src/shell/async.tsx", "src/lib/use-async.ts", "src/lib/surface.ts", "src/pages/FoundationsPage.tsx",
    ]) {
      expect(byPath.has(p), `missing ${p}`).toBe(true);
    }
    expect(byPath.has("src/shell/personas.ts")).toBe(false); // personas live in the overlay now
    // one page per UNIQUE surface route (3) + the Foundations page (4 total)
    const pages = files.filter((f) => f.path.startsWith("src/pages/"));
    expect(pages).toHaveLength(4);
  });

  it("mounts the review-overlay (LCR mode) with surfaces + the EPSS manifest, NOT a mock switcher", () => {
    const app = byPath.get("src/App.tsx")!;
    expect(app).toContain('import { SlowcookReviewOverlay } from "@slowcook-ai/review-overlay/react"');
    expect(app).toContain('reviewMode="lcr"');
    expect(app).toContain("enabled");
    expect(app).toContain("surfaces={REVIEW_SURFACES}");
    expect(app).toContain('testingSurfacesUrl="/testing-surfaces.json"');
    expect(app).toContain('owner="slowcook-dev"');
    // the Foundations universal-state home is routed
    expect(app).toContain('import { FoundationsPage }');
    expect(app).toContain('path="/_foundations"');
    // BrowserRouter (overlay navigates via pushState/pathname), not HashRouter
    expect(app).toContain("BrowserRouter");
    expect(app).not.toContain("HashRouter");
    // the Shell carries no persona switcher
    const shell = byPath.get("src/shell/Shell.tsx")!;
    expect(shell).not.toMatch(/Viewing as|setPersona|persona switcher/i);
  });

  it("review-surfaces = one 'Viewing as' entry per persona → its home route", () => {
    const surfaces = byPath.get("src/review-surfaces.ts")!;
    expect(surfaces).toContain('"label": "founder"');
    expect(surfaces).toContain('"home": "/projects"');
    expect(surfaces).toContain('"label": "operator"');
  });

  it("EPSS manifest = epic(theme) ▸ context(persona) ▸ scenario(When) ▸ state(Given), route as attribute", () => {
    const m = JSON.parse(byPath.get("public/testing-surfaces.json")!);
    const epicLabels = m.epics.map((e: { label: string }) => e.label);
    // the two acceptance-scenario epics + the synthetic Foundations home
    expect(epicLabels).toEqual(["Founder onboarding", "Worker oversight", "Foundations"]);
    expect(m.activeEpicDefault).toBe(m.epics[0].id);

    const onboarding = m.epics.find((e: { label: string }) => e.label === "Founder onboarding");
    expect(onboarding.contexts.map((c: { id: string }) => c.id)).toEqual(["founder"]);
    const fScenarios = onboarding.contexts[0].scenarios;
    expect(fScenarios.map((s: { label: string }) => s.label)).toEqual([
      "They add a GitHub repo",
      "They open the wallet below threshold",
    ]);
    // base is "" (scenarios carry absolute routes; URL = base + route)
    expect(onboarding.contexts[0].base).toBe("");
    // the route is an ATTRIBUTE of the scenario, not its identity
    expect(fScenarios[0].route).toBe("/projects");
    // the Given becomes the state; the Then is carried as `expect`
    expect(fScenarios[0].states[0]).toEqual({ id: "no-prior-project", label: "No prior project", expect: "the project is created" });

    // same When + two Givens → ONE scenario with two states (not two scenarios)
    const oversight = m.epics.find((e: { label: string }) => e.label === "Worker oversight");
    const roster = oversight.contexts[0].scenarios;
    expect(roster).toHaveLength(1);
    expect(roster[0].states.map((s: { label: string }) => s.label)).toEqual(["Workers exist", "No workers yet"]);
  });

  it("the universal UI-Stack states get ONE Foundations home, not a per-page repeat", () => {
    const m = JSON.parse(byPath.get("public/testing-surfaces.json")!);
    const foundations = m.epics.find((e: { id: string }) => e.id === "foundations");
    const sc = foundations.contexts[0].scenarios[0];
    expect(sc.route).toBe("/_foundations");
    expect(sc.states.map((s: { id: string }) => s.id)).toEqual(["loading", "empty", "error"]);
    // and the page actually renders the shared primitive
    const page = byPath.get("src/pages/FoundationsPage.tsx")!;
    expect(page).toContain("Spinner");
    expect(page).toContain("ErrorState");
    expect(page).toContain("useSurfaceState");
  });

  it("each page still sets the @story marker for overlay comment attribution", () => {
    const page = byPath.get("src/pages/AdminWorkersPage.tsx")!;
    expect(page).toContain("// @story story-017");
    expect(page).toContain('useStoryMarker("017")');
  });

  it("package.json carries the overlay + real-SQLite deps", () => {
    const pkg = JSON.parse(byPath.get("package.json")!);
    expect(pkg.dependencies["@slowcook-ai/review-overlay"]).toBeTruthy();
    expect(pkg.dependencies["drizzle-orm"]).toBeTruthy();
    expect(pkg.dependencies["sql.js"]).toBeTruthy();
  });

  it("mockYaml declares the whole-app LCR shape", () => {
    expect(mockYaml()).toMatch(/schema_version: 1/);
    expect(mockYaml()).toMatch(/review_mode: lcr/);
  });
});

describe("epssManifestJson", () => {
  it("maps a Gherkin test case → scenario(When) with state=Given + expect=Then", () => {
    const m = JSON.parse(
      epssManifestJson(
        { ...plan, epss: [{ epic: "E", persona: "p", scenario: "submit the form", state: "a valid draft exists", then: "it is saved", route: "/x", storyId: "1" }] },
        "proj"
      )
    );
    const sc = m.epics[0].contexts[0].scenarios[0];
    expect(sc.label).toBe("submit the form");
    expect(sc.route).toBe("/x");
    expect(sc.states[0]).toEqual({ id: "a-valid-draft-exists", label: "a valid draft exists", expect: "it is saved" });
  });

  it("is empty-safe (no epss → just the Foundations home)", () => {
    const m = JSON.parse(epssManifestJson({ ...plan, epss: [] }, "proj"));
    expect(m.epics).toHaveLength(1);
    expect(m.epics[0].id).toBe("foundations");
  });
});
