import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findStoryTestFiles, extractImports, extractTestids, resolveImport } from "./index.js";

let repo: string;

beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), "slowcook-recon-"));
  mkdirSync(join(repo, "tests/integration"), { recursive: true });
  writeFileSync(
    join(repo, "tests/integration/story-007-ui.test.tsx"),
    `import { MyList } from "@/components/MyList";
import { mockFetch } from "@tests/helpers/fetch";
describe("ui", () => {
  it("renders", () => {
    expect(getByTestId("foo-row")).toBeInTheDocument();
    expect(container.querySelector('[data-testid="bar-list"]')).not.toBeNull();
  });
});`,
    "utf8"
  );
  writeFileSync(
    join(repo, "tests/integration/story-007-page.test.ts"),
    `describe("page", () => { it("works", () => {}) });`,
    "utf8"
  );
});

afterAll(() => {
  rmSync(repo, { recursive: true, force: true });
});

describe("findStoryTestFiles", () => {
  it("finds tests prefixed by story-N", () => {
    const out = findStoryTestFiles(repo, "007");
    expect(out.length).toBe(2);
    expect(out).toContain("tests/integration/story-007-ui.test.tsx");
  });

  it("returns empty for unknown story", () => {
    expect(findStoryTestFiles(repo, "999")).toEqual([]);
  });
});

describe("extractImports", () => {
  it("captures @/ + relative imports", () => {
    const body = `import { A } from "@/components/A";
import { B } from "../helpers/B";
import { C } from "lodash";`;
    const out = extractImports(body);
    expect(out).toContain("@/components/A");
    expect(out).toContain("../helpers/B");
    expect(out).not.toContain("lodash");
  });

  it("dedups", () => {
    const body = `import { A } from "@/x";
import { B } from "@/x";`;
    expect(extractImports(body)).toEqual(["@/x"]);
  });
});

describe("extractTestids", () => {
  it("captures data-testid attributes + getByTestId calls", () => {
    const body = readFileSync(join(repo, "tests/integration/story-007-ui.test.tsx"), "utf8");
    const out = extractTestids(body);
    expect(out).toContain("foo-row");
    expect(out).toContain("bar-list");
  });
});

describe("resolveImport (regression: rewo issue #149 false-positive 'clean')", () => {
  // Recon previously treated mock/src/ as a valid resolution for the
  // `@/` alias. But the consumer's top-level tsconfig points `@/*` at
  // `./src/*` only — vitest can't reach mock/src from a prod test
  // → MANIFEST_DRIFT halt at brew time.
  it("returns null for `@/foo` when foo only exists under mock/src", () => {
    const r = mkdtempSync(join(tmpdir(), "slowcook-recon-resolve-"));
    try {
      mkdirSync(join(r, "mock/src/components/members"), { recursive: true });
      writeFileSync(join(r, "mock/src/components/members/MemberReactionsPage.tsx"), "export const x = 1;", "utf8");
      // `src/components/members/MemberReactionsPage.tsx` deliberately absent.
      expect(resolveImport(r, "@/components/members/MemberReactionsPage")).toBeNull();
    } finally {
      rmSync(r, { recursive: true, force: true });
    }
  });

  it("returns the src/ path when foo exists under src/", () => {
    const r = mkdtempSync(join(tmpdir(), "slowcook-recon-resolve-"));
    try {
      mkdirSync(join(r, "src/components"), { recursive: true });
      writeFileSync(join(r, "src/components/Foo.tsx"), "export const x = 1;", "utf8");
      expect(resolveImport(r, "@/components/Foo")).toBe("src/components/Foo.tsx");
    } finally {
      rmSync(r, { recursive: true, force: true });
    }
  });
});

describe("srcPathToAliasImport (#75 v2 helper)", () => {
  it("converts src/<rel>.tsx to @/<rel>", async () => {
    const { srcPathToAliasImport } = await import("./shape-preserve.js");
    expect(srcPathToAliasImport("src/components/members/MemberReactionsPage.tsx")).toBe(
      "@/components/members/MemberReactionsPage",
    );
  });

  it("strips .ts extension", async () => {
    const { srcPathToAliasImport } = await import("./shape-preserve.js");
    expect(srcPathToAliasImport("src/lib/foo.ts")).toBe("@/lib/foo");
  });

  it("strips .tsx extension on nested path", async () => {
    const { srcPathToAliasImport } = await import("./shape-preserve.js");
    expect(srcPathToAliasImport("src/app/(main)/feed/page.tsx")).toBe(
      "@/app/(main)/feed/page",
    );
  });

  it("converts mock/src/<rel>.tsx to @/<rel> too", async () => {
    const { srcPathToAliasImport } = await import("./shape-preserve.js");
    expect(srcPathToAliasImport("mock/src/components/X.tsx")).toBe("@/components/X");
  });
});

describe("synthesiseShapeTestFile v2 (#75 render-and-assert)", () => {
  it("emits an import per component when emitMode=v2", async () => {
    const { synthesiseShapeTestFile } = await import("./shape-preserve.js");
    const out = synthesiseShapeTestFile({
      story: "018",
      emitMode: "v2",
      shapes: [
        {
          file: "mock/src/components/Foo.tsx",
          componentName: "Foo",
          testids: ["foo-row"],
          visualTokens: ["rounded-full"],
          hasHeader: false,
        },
      ],
    });
    expect(out).toContain(`import Foo from "@/components/Foo";`);
    expect(out).toContain("@testing-library/react");
    expect(out).toContain("renders with default props (no throw)");
    expect(out).toContain(`expect(() => render(<Foo />)).not.toThrow();`);
  });

  it("v2 testid assertion uses queryByTestId on rendered DOM (not source-grep)", async () => {
    const { synthesiseShapeTestFile } = await import("./shape-preserve.js");
    const out = synthesiseShapeTestFile({
      story: "018",
      emitMode: "v2",
      shapes: [
        {
          file: "mock/src/components/Bar.tsx",
          componentName: "Bar",
          testids: ["badge-x"],
          visualTokens: [],
          hasHeader: false,
        },
      ],
    });
    expect(out).toContain(`queryByTestId("badge-x")`);
    // v2 must NOT use the v1 source-grep regex shape
    expect(out).not.toMatch(/expect\(src\)\.toMatch\(\/data-testid/);
  });

  it("v2 token assertion queries the rendered container by class*=", async () => {
    const { synthesiseShapeTestFile } = await import("./shape-preserve.js");
    const out = synthesiseShapeTestFile({
      story: "018",
      emitMode: "v2",
      shapes: [
        {
          file: "mock/src/components/Baz.tsx",
          componentName: "Baz",
          testids: [],
          visualTokens: ["rounded-full", "min-h-[44px]"],
          hasHeader: false,
        },
      ],
    });
    expect(out).toContain(`container.querySelector('[class*="rounded-full"]')`);
    expect(out).toContain(`container.querySelector('[class*="min-h-[44px]"]')`);
  });

  it("v2 emits afterEach cleanup when there's any shape", async () => {
    const { synthesiseShapeTestFile } = await import("./shape-preserve.js");
    const out = synthesiseShapeTestFile({
      story: "018",
      emitMode: "v2",
      shapes: [
        {
          file: "mock/src/components/X.tsx",
          componentName: "X",
          testids: ["a"],
          visualTokens: [],
          hasHeader: false,
        },
      ],
    });
    expect(out).toContain(`import { describe, it, expect, afterEach } from "vitest";`);
    expect(out).toContain(`afterEach(() => { cleanup(); });`);
  });

  it("v2 keeps the no-inline-hex anti-wiring source-grep test", async () => {
    const { synthesiseShapeTestFile } = await import("./shape-preserve.js");
    const out = synthesiseShapeTestFile({
      story: "018",
      emitMode: "v2",
      shapes: [
        {
          file: "mock/src/components/X.tsx",
          componentName: "X",
          testids: ["a"],
          visualTokens: [],
          hasHeader: false,
        },
      ],
    });
    expect(out).toContain("token-family preservation (source-grep)");
    expect(out).toContain("no inline hex in className/style");
  });

  it("v1 (default) emits source-grep tests, no @testing-library import", async () => {
    const { synthesiseShapeTestFile } = await import("./shape-preserve.js");
    const out = synthesiseShapeTestFile({
      story: "018",
      shapes: [
        {
          file: "mock/src/components/Foo.tsx",
          componentName: "Foo",
          testids: ["foo-row"],
          visualTokens: [],
          hasHeader: false,
        },
      ],
    });
    expect(out).not.toContain("@testing-library/react");
    expect(out).toMatch(/expect\(src\)\.toMatch\(\/data-testid/);
  });

  it("v2 emits the it.skip line when no testids/tokens/header found", async () => {
    const { synthesiseShapeTestFile } = await import("./shape-preserve.js");
    const out = synthesiseShapeTestFile({
      story: "018",
      emitMode: "v2",
      shapes: [
        {
          file: "mock/src/components/Empty.tsx",
          componentName: "Empty",
          testids: [],
          visualTokens: [],
          hasHeader: false,
        },
      ],
    });
    expect(out).toContain(`it.skip("no testids/tokens/header found in mock UI`);
  });
});
