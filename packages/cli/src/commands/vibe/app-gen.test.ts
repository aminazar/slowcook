import { describe, it, expect } from "vitest";
import { generateLcrApp, routeToName, mockYaml } from "./app-gen.js";
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
  it("PascalCases route segments, drops params, handles root", () => {
    expect(routeToName("/admin/workers")).toBe("AdminWorkersPage");
    expect(routeToName("/projects/:projectId/wallet")).toBe("ProjectsWalletPage");
    expect(routeToName("/")).toBe("HomePage");
    expect(routeToName("/review/:guestToken")).toBe("ReviewPage");
  });
});

describe("generateLcrApp", () => {
  const files = generateLcrApp(plan, { projectName: "dash" });
  const byPath = new Map(files.map((f) => [f.path, f.content]));

  it("emits the Vite scaffold + shell + one page per UNIQUE route", () => {
    for (const p of ["package.json", "vite.config.ts", "index.html", "tsconfig.json", "src/main.tsx", "src/index.css", "src/App.tsx", "src/shell/Shell.tsx", "src/shell/personas.ts", "src/shell/useStoryMarker.ts"]) {
      expect(byPath.has(p), `missing ${p}`).toBe(true);
    }
    // 3 unique routes → 3 pages (the /admin/workers dup merges)
    const pages = files.filter((f) => f.path.startsWith("src/pages/"));
    expect(pages).toHaveLength(3);
    expect(byPath.has("src/pages/AdminWorkersPage.tsx")).toBe(true);
  });

  it("App.tsx routes every surface + redirects / to the home route", () => {
    const app = byPath.get("src/App.tsx")!;
    expect(app).toContain('<Route path="/projects" element={<ProjectsPage />} />');
    expect(app).toContain('<Route path="/admin/workers" element={<AdminWorkersPage />} />');
    expect(app).toContain('<Navigate to="/projects" replace />'); // home
    expect(app).toContain("HashRouter");
  });

  it("each page sets the @story marker + lists its personas/states", () => {
    const page = byPath.get("src/pages/AdminWorkersPage.tsx")!;
    expect(page).toContain("// @story story-017");
    expect(page).toContain('useStoryMarker("017")');
    expect(page).toContain("persona: operator");
    expect(page).toContain("populated, empty"); // both states merged from the dup route
  });

  it("the persona registry derives home + routes per persona", () => {
    const personas = byPath.get("src/shell/personas.ts")!;
    expect(personas).toContain('"id": "founder"');
    expect(personas).toContain('"home": "/projects"');
    expect(personas).toContain('"chrome": "admin"');
  });

  it("package.json carries the real-SQLite deps", () => {
    const pkg = JSON.parse(byPath.get("package.json")!);
    expect(pkg.dependencies["drizzle-orm"]).toBeTruthy();
    expect(pkg.dependencies["sql.js"]).toBeTruthy();
    expect(pkg.devDependencies["@tailwindcss/vite"]).toBeTruthy();
  });

  it("mockYaml declares the whole-app LCR shape", () => {
    expect(mockYaml()).toMatch(/schema_version: 1/);
    expect(mockYaml()).toMatch(/review_mode: lcr/);
    expect(mockYaml()).toMatch(/router_file: mock\/src\/App\.tsx/);
  });
});
