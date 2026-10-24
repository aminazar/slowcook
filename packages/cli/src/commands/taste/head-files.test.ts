import { describe, it, expect } from "vitest";
import { rankHeadFiles, importSpecifiers, importResolvesTo, isSourcePath } from "./head-files.js";
import { buildTastePrompt } from "./review.js";

describe("WP2 — taste reads src at the PR head", () => {
  it("import-referenced src ranks right after the contract files", () => {
    const changed = [
      "src/lib/unrelated.ts",
      "src/components/RationPill.tsx",
      "tests/integration/story-022.test.tsx",
      "specs/story-022.yaml",
      "src/app/api/rations/route.ts",
    ];
    const tests = new Map([
      [
        "tests/integration/story-022.test.tsx",
        `import { render } from "@testing-library/react";\nimport { RationPill } from "@/components/RationPill";\nimport { GET } from "../../src/app/api/rations/route";\n`,
      ],
    ]);
    const ranked = rankHeadFiles(changed, tests);
    expect(ranked.paths).toEqual([
      "tests/integration/story-022.test.tsx",
      "specs/story-022.yaml",
      "src/components/RationPill.tsx",
      "src/app/api/rations/route.ts",
      "src/lib/unrelated.ts",
    ]);
    expect([...ranked.sourcePaths]).toEqual([
      "src/components/RationPill.tsx",
      "src/app/api/rations/route.ts",
      "src/lib/unrelated.ts",
    ]);
  });

  it("caps at 12 and never drops a contract file for a src file", () => {
    const changed = [
      ...Array.from({ length: 6 }, (_, i) => `tests/t${i}.test.ts`),
      ...Array.from({ length: 20 }, (_, i) => `src/s${i}.ts`),
    ];
    const ranked = rankHeadFiles(changed, new Map());
    expect(ranked.paths.length).toBe(12);
    expect(ranked.paths.filter((p) => p.startsWith("tests/")).length).toBe(6);
  });

  it("colocated test files and bare packages are not src", () => {
    expect(isSourcePath("src/x.test.ts")).toBe(false);
    expect(isSourcePath("src/x.ts")).toBe(true);
    expect(isSourcePath("packages/ui/src/x.ts")).toBe(true);
    expect(importResolvesTo("react", "tests/a.test.ts", "src/react.ts")).toBe(false);
    expect(importResolvesTo("./helpers", "tests/a.test.ts", "tests/helpers/index.ts")).toBe(true);
    expect(importSpecifiers(`const x = require("./y");\nimport type { T } from './z.js';`)).toEqual(["./y", "./z.js"]);
  });

  it("the prompt labels src head files as the shipped signatures to compare against", () => {
    const { user } = buildTastePrompt({
      prNumber: 1,
      prTitle: "t",
      prBody: "",
      headBranch: "b",
      kind: "tests",
      storyId: "022",
      diff: "",
      specYaml: null,
      sourceIssueTitle: null,
      sourceIssueBody: null,
      issueThread: null,
      prThread: null,
      manifestJson: null,
      headFiles: [
        { path: "tests/integration/story-022.test.tsx", content: "it('x')" },
        { path: "src/components/RationPill.tsx", content: "export default async function RationPill() {}", source: true },
      ],
      commitSubjects: null,
      constitution: "",
      analyzeFindings: "",
    });
    expect(user).toContain("### src/components/RationPill.tsx (shipped source — compare signatures against this)");
    expect(user).toContain("### tests/integration/story-022.test.tsx\n");
  });
});
