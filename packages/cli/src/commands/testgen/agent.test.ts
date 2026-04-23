import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  extractTestIdsFromFile,
  buildProjectContext,
  lintTierOneTest,
  parseTestgenBundle,
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

  it("flags vi.mock WITH a factory (2-arg form, inline fake construction)", () => {
    const src = `
import { vi } from "vitest";
vi.mock("@/lib/supabase", () => ({ createClient: vi.fn() }));
`;
    const violations = lintTierOneTest(FILE, src);
    expect(violations.some((v) => v.pattern === "vi.mock(path, factory)")).toBe(true);
    expect(violations.some((v) => v.pattern === "vi.fn(")).toBe(true);
  });

  it("ALLOWS vi.mock in the 1-arg auto-mock form (needed for module-boundary injection)", () => {
    const src = `
import { vi, describe, it, beforeEach } from "vitest";
import { createClient } from "@/utils/supabase/server";
import { mockSupabase, resetMocks } from "@tests/helpers/mocks";

vi.mock("@/utils/supabase/server");

describe("handler", () => {
  beforeEach(() => resetMocks());
  it("works", async () => {
    const supabase = mockSupabase({ user: { id: "u1" } });
    vi.mocked(createClient).mockReturnValue(supabase as never);
  });
});
`;
    expect(lintTierOneTest(FILE, src)).toEqual([]);
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

describe("parseTestgenBundle — multi-artifact LLM output", () => {
  it("parses test-file-only output (no stubs, no helpers)", () => {
    const raw = `
<test_file>
import { describe, it } from "vitest";
describe("x", () => { it("y", () => {}); });
</test_file>
`;
    const b = parseTestgenBundle(raw, "042");
    expect(b.testContent).toContain("describe");
    expect(b.stubs).toEqual([]);
    expect(b.helpers).toEqual([]);
  });

  it("parses test + stub + helper bundle with paths", () => {
    const raw = `
<test_file>
import { GET } from "@/app/api/foo/route";
</test_file>

<stub path="src/app/api/foo/route.ts">
// @slowcook-stub story-042
export async function GET(): Promise<Response> { return new Response(); }
</stub>

<helper path="tests/helpers/mocks/foo.ts">
import { vi } from "vitest";
export function mockFoo() { return {}; }
</helper>
`;
    const b = parseTestgenBundle(raw, "042");
    expect(b.testContent).toContain(`from "@/app/api/foo/route"`);
    expect(b.stubs).toHaveLength(1);
    expect(b.stubs[0]?.path).toBe("src/app/api/foo/route.ts");
    expect(b.stubs[0]?.contents).toContain("@slowcook-stub");
    expect(b.helpers).toHaveLength(1);
    expect(b.helpers[0]?.path).toBe("tests/helpers/mocks/foo.ts");
    expect(b.helpers[0]?.contents).toContain("mockFoo");
  });

  it("parses multiple stubs and multiple helpers", () => {
    const raw = `
<test_file>test</test_file>
<stub path="a/route.ts">alpha</stub>
<stub path="b/route.ts">beta</stub>
<helper path="tests/helpers/mocks/x.ts">hx</helper>
<helper path="tests/helpers/mocks/y.ts">hy</helper>
`;
    const b = parseTestgenBundle(raw, "042");
    expect(b.stubs.map((s) => s.path)).toEqual(["a/route.ts", "b/route.ts"]);
    expect(b.helpers.map((h) => h.path)).toEqual([
      "tests/helpers/mocks/x.ts",
      "tests/helpers/mocks/y.ts",
    ]);
  });

  it("strips an outer markdown code fence if the LLM wraps everything", () => {
    const raw = "```\n<test_file>inside</test_file>\n```";
    expect(parseTestgenBundle(raw, "042").testContent).toContain("inside");
  });

  it("strips inner TS code fences on each block", () => {
    const raw = `
<test_file>
\`\`\`ts
import { it } from "vitest";
\`\`\`
</test_file>
`;
    expect(parseTestgenBundle(raw, "042").testContent.trim()).toBe(
      'import { it } from "vitest";'
    );
  });

  it("throws when <test_file> block is missing", () => {
    expect(() => parseTestgenBundle("no tags here", "042")).toThrow(
      /missing a <test_file>/
    );
  });

  it("parses a full bundle with UI test + UI stub (mode: full)", () => {
    // String-concat `vitest-environment` so the pragma isn't picked up by
    // vitest's parser when scanning THIS test file's contents.
    const pragmaComment = "// @" + "vitest-environment jsdom";
    const raw = `
<test_file>import { POST } from "@/app/api/foo/route";</test_file>
<stub path="src/app/api/foo/route.ts">// @slowcook-stub story-042
export async function POST(): Promise<Response> { return new Response(); }</stub>
<ui_test_file>${pragmaComment}
import { renderWithProviders } from "@tests/helpers/render";</ui_test_file>
<ui_stub path="src/components/foo/Form.tsx">// @slowcook-stub story-042
export default function Form(): never { throw new Error("stub"); }</ui_stub>
`;
    const b = parseTestgenBundle(raw, "042", "full");
    expect(b.testContent).toContain(`from "@/app/api/foo/route"`);
    expect(b.stubs).toHaveLength(1);
    expect(b.uiTestContent).toContain("renderWithProviders");
    expect(b.uiStubs).toHaveLength(1);
    expect(b.uiStubs[0]?.path).toBe("src/components/foo/Form.tsx");
  });

  it("throws when <ui_test_file> is missing in ui-only mode", () => {
    const raw = `<test_file>handler stays here</test_file>`;
    expect(() => parseTestgenBundle(raw, "042", "ui-only")).toThrow(
      /missing a <ui_test_file>/
    );
  });

  it("does not require <test_file> in ui-only mode", () => {
    const pragmaComment = "// @" + "vitest-environment jsdom";
    const raw = `
<ui_test_file>${pragmaComment}
import { renderWithProviders } from "@tests/helpers/render";</ui_test_file>
`;
    const b = parseTestgenBundle(raw, "042", "ui-only");
    expect(b.testContent).toBe("");
    expect(b.uiTestContent).toContain("renderWithProviders");
  });

  it("requires BOTH handler and UI in full mode", () => {
    const handlerOnly = `<test_file>handler</test_file>`;
    expect(() => parseTestgenBundle(handlerOnly, "042", "full")).toThrow(
      /missing a <ui_test_file>/
    );
    const uiOnly = `<ui_test_file>ui</ui_test_file>`;
    expect(() => parseTestgenBundle(uiOnly, "042", "full")).toThrow(
      /missing a <test_file>/
    );
  });

  it("ignores empty <stub>, <helper>, or <ui_stub> blocks", () => {
    const raw = `
<test_file>t</test_file>
<stub path="empty.ts">
</stub>
<helper path="also-empty.ts">

</helper>
<ui_stub path="blank.tsx">

</ui_stub>
`;
    const b = parseTestgenBundle(raw, "042");
    expect(b.stubs).toEqual([]);
    expect(b.helpers).toEqual([]);
    expect(b.uiStubs).toEqual([]);
  });
});
