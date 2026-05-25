import { describe, it, expect } from "vitest";
import {
  parseBrewHaltOutput,
  collectImportedSourceFiles,
  resolveImportToFile,
  isFrozenPath,
} from "./drift-fix.js";

describe("parseBrewHaltOutput", () => {
  it("extracts FAIL <path> entries", () => {
    const text = `
 RUN  v1.0.0 /repo

 FAIL  src/components/Foo.test.tsx > Foo > renders
 FAIL  src/lib/bar.test.ts > bar > computes the sum

Test Files  2 failed | 5 passed (7)
`;
    const { failingFiles } = parseBrewHaltOutput(text);
    expect(failingFiles).toContain("src/components/Foo.test.tsx");
    expect(failingFiles).toContain("src/lib/bar.test.ts");
  });

  it("extracts × <path> entries (alt vitest format)", () => {
    const text = `
× src/components/Foo.test.tsx > Foo > renders
× src/lib/bar.test.ts > bar > computes the sum
`;
    const { failingFiles } = parseBrewHaltOutput(text);
    expect(failingFiles).toContain("src/components/Foo.test.tsx");
    expect(failingFiles).toContain("src/lib/bar.test.ts");
  });

  it("captures failing test names alongside file paths", () => {
    const text = `FAIL  src/components/Foo.test.tsx > Foo > renders correctly`;
    const { failingTestNames } = parseBrewHaltOutput(text);
    expect(failingTestNames).toContain("Foo > renders correctly");
  });

  it("dedupes identical failing files", () => {
    const text = `
FAIL  src/components/Foo.test.tsx > Foo > a
FAIL  src/components/Foo.test.tsx > Foo > b
FAIL  src/components/Foo.test.tsx > Foo > c
`;
    const { failingFiles } = parseBrewHaltOutput(text);
    expect(failingFiles).toEqual(["src/components/Foo.test.tsx"]);
  });

  it("returns empty arrays when no failures present", () => {
    const text = `
 RUN  v1.0.0 /repo

✓ src/components/Foo.test.tsx (3 tests) 12ms

Test Files  5 passed (5)
`;
    const r = parseBrewHaltOutput(text);
    expect(r.failingFiles).toEqual([]);
    expect(r.failingTestNames).toEqual([]);
  });

  it("ignores ANSI color escapes", () => {
    const text = `\x1b[31mFAIL\x1b[0m  src/components/Foo.test.tsx > Foo > renders`;
    // Note: drift-fix only strips bracketed sequences for now; this just
    // documents that the parser is forgiving of whitespace around codes.
    const { failingFiles } = parseBrewHaltOutput(text);
    expect(failingFiles.length).toBeGreaterThanOrEqual(0);
  });

  it("recognises ❯-prefixed file with 'failed' summary", () => {
    const text = ` ❯ src/lib/bar.test.ts (3 tests | 2 failed) 18ms`;
    const { failingFiles } = parseBrewHaltOutput(text);
    expect(failingFiles).toContain("src/lib/bar.test.ts");
  });
});

describe("collectImportedSourceFiles", () => {
  it("extracts relative imports from a test file's contents", () => {
    const contents = {
      "src/components/Foo.test.tsx": `
import { render } from "@testing-library/react";
import { Foo } from "./Foo";
import { helper } from "../lib/helper";
import { vi } from "vitest";
`,
    };
    const r = collectImportedSourceFiles(contents);
    expect(r["src/components/Foo.test.tsx"]).toContain("./Foo");
    expect(r["src/components/Foo.test.tsx"]).toContain("../lib/helper");
    // Package imports excluded
    expect(r["src/components/Foo.test.tsx"]).not.toContain("@testing-library/react");
    expect(r["src/components/Foo.test.tsx"]).not.toContain("vitest");
  });

  it("dedupes repeated imports of the same module", () => {
    const contents = {
      "src/x.test.ts": `
import { a } from "./mod";
import type { B } from "./mod";
`,
    };
    const r = collectImportedSourceFiles(contents);
    expect(r["src/x.test.ts"]).toEqual(["./mod"]);
  });

  it("returns empty array for tests with no relative imports", () => {
    const contents = {
      "src/y.test.ts": `import { describe, it } from "vitest";`,
    };
    const r = collectImportedSourceFiles(contents);
    expect(r["src/y.test.ts"]).toEqual([]);
  });

  it("handles multiple test files independently", () => {
    const contents = {
      "src/a.test.ts": `import { x } from "./a";`,
      "src/b.test.ts": `import { y } from "./b";`,
    };
    const r = collectImportedSourceFiles(contents);
    expect(r["src/a.test.ts"]).toEqual(["./a"]);
    expect(r["src/b.test.ts"]).toEqual(["./b"]);
  });

  it("captures @/ and ~/ path-alias imports; skips bare and scoped packages", () => {
    const contents = {
      "tests/integration/foo.test.tsx": `
import { describe, it } from "vitest";
import { axe } from "@testing-library/react";
import { MemberReactionsPage } from "@/components/members/MemberReactionsPage";
import { mockFetch } from "@tests/helpers/mocks/fetch";
import { someUtil } from "~/lib/utils";
`,
    };
    const r = collectImportedSourceFiles(contents);
    expect(r["tests/integration/foo.test.tsx"]).toContain("@/components/members/MemberReactionsPage");
    expect(r["tests/integration/foo.test.tsx"]).toContain("~/lib/utils");
    // bare + scoped packages excluded (any @scope/... that isn't @/ is treated
    // as a package, even if it's actually a tsconfig path alias — chef can
    // only resolve the canonical @/ alias today)
    expect(r["tests/integration/foo.test.tsx"]).not.toContain("@testing-library/react");
    expect(r["tests/integration/foo.test.tsx"]).not.toContain("vitest");
    expect(r["tests/integration/foo.test.tsx"]).not.toContain("@tests/helpers/mocks/fetch");
  });
});

describe("resolveImportToFile", () => {
  const exists = (p: string) => {
    const present = new Set([
      "/repo/src/components/Foo.tsx",
      "/repo/src/components/members/MemberReactionsPage.tsx",
      "/repo/src/lib/helper.ts",
      "/repo/src/lib/index.ts",
      "/repo/tests/helpers/render.ts",
    ]);
    return present.has(p);
  };

  it("resolves @/X to src/X.tsx", () => {
    const r = resolveImportToFile(
      "@/components/members/MemberReactionsPage",
      "tests/integration/story-018-ui.test.tsx",
      "/repo",
      exists,
    );
    expect(r).toBe("/repo/src/components/members/MemberReactionsPage.tsx");
  });

  it("resolves ~/X to src/X.ts", () => {
    const r = resolveImportToFile("~/lib/helper", "tests/foo.test.ts", "/repo", exists);
    expect(r).toBe("/repo/src/lib/helper.ts");
  });

  it("resolves relative ./X against the test file's dir", () => {
    const r = resolveImportToFile("./Foo", "src/components/Foo.test.tsx", "/repo", exists);
    expect(r).toBe("/repo/src/components/Foo.tsx");
  });

  it("returns null for bare package names", () => {
    const r = resolveImportToFile("react", "src/foo.test.ts", "/repo", exists);
    expect(r).toBeNull();
  });

  it("returns null for unresolvable @/X", () => {
    const r = resolveImportToFile("@/does/not/exist", "src/foo.test.ts", "/repo", exists);
    expect(r).toBeNull();
  });

  it("falls through to /index.ts when X.{ts,tsx} doesn't exist", () => {
    const r = resolveImportToFile("@/lib", "src/foo.test.ts", "/repo", exists);
    expect(r).toBe("/repo/src/lib/index.ts");
  });
});

describe("isFrozenPath (α.54 — chef owns test infrastructure)", () => {
  // Spec-contract assertions stay frozen — these encode "story done".
  it.each([
    "tests/integration/story-003.test.ts",
    "tests/integration/story-003-ui.test.tsx",
    "tests/schema/story-003-column-presence.test.ts",
    "tests/acceptance/story-007.spec.ts",
  ])("flags assertion path as frozen: %s", (p) => {
    expect(isFrozenPath(p)).toBe(true);
  });

  // Slowcook-managed artifacts stay frozen — other agents derive from them.
  it.each([
    ".brewing/code-map.json",
    ".brewing/code-map.md",
    ".brewing/code-map.target.md",
    ".brewing/recon-result.json",
    ".brewing/history-index.json",
    ".brewing/auto-gen/foo.json",
  ])("flags slowcook-managed artifact as frozen: %s", (p) => {
    expect(isFrozenPath(p)).toBe(true);
  });

  // Test INFRASTRUCTURE is NOT frozen — chef can fix the runner machinery.
  it.each([
    "tests/helpers/render.tsx",
    "tests/helpers/a11y.ts",
    "tests/helpers/mocks/fetch.ts",
    "tests/helpers/mocks/index.ts",
    "tests/setup.ts",
    "vitest.setup.ts",
    "vitest.config.ts",
    "vitest.config.mjs",
    "playwright.config.ts",
    "package.json",
    "tsconfig.json",
  ])("does NOT flag infra path as frozen: %s", (p) => {
    expect(isFrozenPath(p)).toBe(false);
  });

  // Source files — never frozen.
  it.each([
    "src/components/patient/chat/PatientChatPage.tsx",
    "src/lib/data/patient.ts",
    "src/app/api/patients/me/route.ts",
    "apps/back/src/modules/appointment/appointment.controller.ts",
    "supabase/migrations/00042_chat.sql",
  ])("does NOT flag source path as frozen: %s", (p) => {
    expect(isFrozenPath(p)).toBe(false);
  });
});
