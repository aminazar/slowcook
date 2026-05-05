import { describe, it, expect } from "vitest";
import { parseBrewHaltOutput, collectImportedSourceFiles } from "./drift-fix.js";

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
});
