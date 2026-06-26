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
  surfaces: [
    { route: "/projects", persona: "founder", storyId: "001", home: true, states: ["empty", "populated"] },
    { route: "/projects/:projectId/wallet", persona: "founder", storyId: "004", home: false, states: ["edge"] },
    { route: "/admin/workers", persona: "operator", storyId: "017", home: true, states: ["populated"] },
    { route: "/admin/workers", persona: "operator", storyId: "017", home: true, states: ["empty"] }, // dup route, merges
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

  it("emits the Vite scaffold + minimal shell + EPSS manifest + one page per UNIQUE route", () => {
    for (const p of ["package.json", "vite.config.ts", "src/main.tsx", "src/App.tsx", "src/shell/Shell.tsx", "src/review-surfaces.ts", "src/shell/useStoryMarker.ts", "public/testing-surfaces.json"]) {
      expect(byPath.has(p), `missing ${p}`).toBe(true);
    }
    expect(byPath.has("src/shell/personas.ts")).toBe(false); // personas live in the overlay now
    const pages = files.filter((f) => f.path.startsWith("src/pages/"));
    expect(pages).toHaveLength(3);
  });

  it("mounts the review-overlay (LCR mode) with surfaces + the EPSS manifest, NOT a mock switcher", () => {
    const app = byPath.get("src/App.tsx")!;
    expect(app).toContain('import { SlowcookReviewOverlay } from "@slowcook-ai/review-overlay/react"');
    expect(app).toContain('reviewMode="lcr"');
    expect(app).toContain("enabled");
    expect(app).toContain("surfaces={REVIEW_SURFACES}");
    expect(app).toContain('testingSurfacesUrl="/testing-surfaces.json"');
    expect(app).toContain('owner="slowcook-dev"');
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

  it("EPSS manifest = epic ▸ context(persona) ▸ scenario(route) ▸ state", () => {
    const m = JSON.parse(byPath.get("public/testing-surfaces.json")!);
    expect(m.epics).toHaveLength(1);
    const ctxIds = m.epics[0].contexts.map((c: { id: string }) => c.id).sort();
    expect(ctxIds).toEqual(["founder", "operator"]);
    const operator = m.epics[0].contexts.find((c: { id: string }) => c.id === "operator");
    expect(operator.scenarios[0].route).toBe("/admin/workers");
    // both states from the merged dup route
    expect(operator.scenarios[0].states.map((s: { id: string }) => s.id).sort()).toEqual(["empty", "populated"]);
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
  it("defaults a stateless surface to 'populated'", () => {
    const m = JSON.parse(
      epssManifestJson(
        { ...plan, surfaces: [{ route: "/x", persona: "p", storyId: "1", home: true, states: [] }], personas: [{ id: "p", fromStories: ["1"] }] },
        "proj"
      )
    );
    expect(m.epics[0].contexts[0].scenarios[0].states).toEqual([{ id: "populated", label: "populated" }]);
  });
});
