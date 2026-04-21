import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  extractTestIdsFromFile,
  buildProjectContext,
  lintTierOneTest,
} from "./agent.js";

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

  it("lists available mock helpers when the helpers directory has files", () => {
    const repo = mkRepo();
    try {
      mkdirSync(join(repo, "tests", "helpers", "mocks"), { recursive: true });
      writeFileSync(
        join(repo, "tests", "helpers", "mocks", "supabase.ts"),
        "export function mockSupabase(opts: { auth?: unknown }) { /* ... */ }",
        "utf8"
      );
      const ctx = buildProjectContext(repo);
      expect(ctx).toContain("Available mock helpers");
      expect(ctx).toContain("supabase.ts");
      expect(ctx).toContain("mockSupabase");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("warns when the helpers directory is missing entirely", () => {
    const repo = mkRepo();
    try {
      const ctx = buildProjectContext(repo);
      expect(ctx).toContain("No `tests/helpers/mocks/` directory yet");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});

describe("lintTierOneTest — tier-1 conformance gate", () => {
  const FILE = "tests/integration/story-099.test.ts";

  it("accepts a conformant tier-1 test", () => {
    const src = `
import { describe, it, expect, beforeEach } from "vitest";
import { POST } from "@/app/api/rewos/route";
import { mockSupabase, resetMocks } from "@/tests/helpers/mocks";

describe("POST /api/rewos", () => {
  beforeEach(() => resetMocks());
  it("returns 201", async () => {
    const supabase = mockSupabase({ insert: { returning: { id: "x" } } });
    const req = new Request("http://test/api/rewos", { method: "POST" });
    const res = await POST(req);
    expect(res.status).toBe(201);
    expect(supabase.from).toHaveBeenCalledWith("rewos");
  });
});
`;
    expect(lintTierOneTest(FILE, src)).toEqual([]);
  });

  it("flags inline vi.mock", () => {
    const src = `
import { vi } from "vitest";
vi.mock("@/lib/supabase", () => ({ createClient: vi.fn() }));
`;
    const violations = lintTierOneTest(FILE, src);
    expect(violations.some((v) => v.pattern === "vi.mock(")).toBe(true);
    expect(violations.some((v) => v.pattern === "vi.fn(")).toBe(true);
  });

  it("flags fetch() calls (tier-1 must not hit HTTP)", () => {
    const src = `
it("hits the API", async () => {
  const res = await fetch("http://localhost:3000/api/rewos");
  expect(res.status).toBe(200);
});
`;
    const violations = lintTierOneTest(FILE, src);
    expect(violations.some((v) => v.pattern === "fetch(")).toBe(true);
  });

  it("flags skipped and todo tests", () => {
    const src = `
it.skip("skipped", () => {});
test.todo("todo");
`;
    const violations = lintTierOneTest(FILE, src);
    // Both `it.skip` and `test.todo` should be caught
    expect(violations.filter((v) => v.pattern.includes("skip"))).toHaveLength(2);
  });

  it("flags HTTP-mocking library imports", () => {
    const src = `import { setupServer } from "msw";`;
    const violations = lintTierOneTest(FILE, src);
    expect(violations.some((v) => v.pattern === "HTTP mock library import")).toBe(true);
  });

  it("does NOT flag banned patterns inside comments", () => {
    const src = `
// Do not use vi.mock(...) — use helpers instead.
/* fetch("http://bad") is banned. */
it("passes", () => {});
`;
    expect(lintTierOneTest(FILE, src)).toEqual([]);
  });

  it("does NOT flag banned patterns inside string literals (e.g. docstrings)", () => {
    const src = `
const msg = "avoid vi.mock( in tier-1 tests";
const tip = \`example: fetch("http://localhost:3000")\`;
it("passes", () => { expect(msg).toContain("vi.mock"); });
`;
    expect(lintTierOneTest(FILE, src)).toEqual([]);
  });
});
