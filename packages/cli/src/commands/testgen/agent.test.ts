import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractTestIdsFromFile, buildProjectContext } from "./agent.js";

const FILE = "tests/integration/story-042.test.ts";

describe("extractTestIdsFromFile", () => {
  it("extracts a single top-level it()", () => {
    const src = `
import { test, expect } from "vitest";
test("returns 200 on happy path", () => {
  expect(1).toBe(1);
});
`;
    const ids = extractTestIdsFromFile(FILE, src);
    expect(ids).toEqual([`${FILE} > returns 200 on happy path`]);
  });

  it("extracts tests nested inside a single describe", () => {
    const src = `
describe("POST /api/reactions", () => {
  it("creates a reaction", () => {});
  it("rejects when ration exhausted", () => {});
});
`;
    const ids = extractTestIdsFromFile(FILE, src);
    expect(ids).toEqual([
      `${FILE} > POST /api/reactions > creates a reaction`,
      `${FILE} > POST /api/reactions > rejects when ration exhausted`,
    ]);
  });

  it("handles nested describe blocks", () => {
    const src = `
describe("POST /api/reactions", () => {
  describe("when authenticated", () => {
    it("succeeds", () => {});
  });
  describe("when anonymous", () => {
    it("returns 401", () => {});
  });
});
`;
    const ids = extractTestIdsFromFile(FILE, src);
    expect(ids).toEqual([
      `${FILE} > POST /api/reactions > when authenticated > succeeds`,
      `${FILE} > POST /api/reactions > when anonymous > returns 401`,
    ]);
  });

  it("handles describes that don't nest (siblings at top level)", () => {
    const src = `
describe("first", () => {
  it("a", () => {});
});
describe("second", () => {
  it("b", () => {});
});
`;
    const ids = extractTestIdsFromFile(FILE, src);
    expect(ids).toEqual([
      `${FILE} > first > a`,
      `${FILE} > second > b`,
    ]);
  });

  it("treats `test(...)` as equivalent to `it(...)`", () => {
    const src = `
describe("outer", () => {
  test("via test()", () => {});
  it("via it()", () => {});
});
`;
    const ids = extractTestIdsFromFile(FILE, src);
    expect(ids).toEqual([
      `${FILE} > outer > via test()`,
      `${FILE} > outer > via it()`,
    ]);
  });

  it("handles single-quoted, double-quoted, and escaped quotes in names", () => {
    const src = `
describe('single-quoted describe', () => {
  it("double-quoted it", () => {});
  it('single with "quotes" inside', () => {});
  it("double with 'quotes' inside", () => {});
});
`;
    const ids = extractTestIdsFromFile(FILE, src);
    expect(ids).toContain(`${FILE} > single-quoted describe > double-quoted it`);
    expect(ids).toContain(`${FILE} > single-quoted describe > single with "quotes" inside`);
    expect(ids).toContain(`${FILE} > single-quoted describe > double with 'quotes' inside`);
  });

  it("ignores describes/its that appear inside string literals", () => {
    const src = `
const message = 'describe("not a test", () => {})';
describe("real", () => {
  it("real test", () => {});
});
`;
    const ids = extractTestIdsFromFile(FILE, src);
    expect(ids).toEqual([`${FILE} > real > real test`]);
  });

  it("ignores describes/its that appear inside comments", () => {
    const src = `
// describe("commented out", () => {})
/* it("also commented", () => {}) */
describe("real", () => {
  it("real test", () => {});
});
`;
    const ids = extractTestIdsFromFile(FILE, src);
    expect(ids).toEqual([`${FILE} > real > real test`]);
  });

  it("returns a fallback marker when no tests are parseable", () => {
    const src = `// empty file with no tests`;
    const ids = extractTestIdsFromFile(FILE, src);
    expect(ids).toHaveLength(1);
    expect(ids[0]).toContain("no tests parsed");
  });

  it("deduplicates identical ids (same describe/it name combo appearing twice)", () => {
    const src = `
describe("dupes", () => {
  it("same", () => {});
  it("same", () => {});
});
`;
    const ids = extractTestIdsFromFile(FILE, src);
    expect(ids).toEqual([`${FILE} > dupes > same`]);
  });
});

describe("buildProjectContext", () => {
  function mkRepo(): string {
    return mkdtempSync(join(tmpdir(), "slowcook-testgen-ctx-"));
  }

  it("includes `.brewing/context.md` contents when present", () => {
    const repo = mkRepo();
    try {
      mkdirSync(join(repo, ".brewing"), { recursive: true });
      writeFileSync(
        join(repo, ".brewing", "context.md"),
        "## Testing conventions\nUse vi.mock for external boundaries.",
        "utf8"
      );
      const ctx = buildProjectContext(repo);
      expect(ctx).toContain("Project overview (from `.brewing/context.md`)");
      expect(ctx).toContain("Use vi.mock for external boundaries");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("omits the context.md section when the file is missing", () => {
    const repo = mkRepo();
    try {
      const ctx = buildProjectContext(repo);
      expect(ctx).not.toContain("context.md");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});
