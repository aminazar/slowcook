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
