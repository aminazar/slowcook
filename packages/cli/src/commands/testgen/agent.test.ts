import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  extractTestIdsFromFile,
  buildProjectContext,
  lintTierOneTest,
  validateImportClosure,
  formatImportClosureViolations,
  parseTestgenBundle,
  extractDdlColumnsFromInvariants,
  extractDdlColumnsFromSpec,
  buildSchemaAssertionTestContent,
  buildPageLinkTestContent,
  buildSchemaPresenceTestContent,
  buildStylingPresenceTestContent,
  resolveImportToSourcePath,
  mineTestExemplars,
  collectTargetSpecs,
} from "./agent.js";
import type { Spec } from "@slowcook-ai/core";
import { normalizeSpecId } from "./index.js";

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

  it("preserves describe prefix when nested it() body uses a regex literal with an apostrophe (0.12.6 regression)", () => {
    // Real-world repro from rewo's story-007-ui.test.tsx. The
    // sanitiser previously didn't recognise regex literals; an
    // apostrophe inside `/haven'?t/i` opened a single-quote string
    // mode that swallowed all braces until the next apostrophe far
    // below — making nested it()s appear UNATTACHED to their
    // describe. The manifest then stored \`file > test name\` (no
    // prefix), and brew halted with MANIFEST_DRIFT because vitest
    // reported \`file > Outer > test name\` instead.
    const src = `
describe("Outer", () => {
  it("first uses a regex with apostrophe", () => {
    expect(text).toMatch(/you haven'?t saved anything yet/i);
  });

  it("second is the canary — should still see Outer prefix", () => {});
});
`;
    const ids = extractTestIdsFromFile(FILE, src);
    expect(ids).toEqual([
      `${FILE} > Outer > first uses a regex with apostrophe`,
      `${FILE} > Outer > second is the canary — should still see Outer prefix`,
    ]);
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

  it("throws when <test_file> block is missing AND mode requires it (no fallback available)", () => {
    expect(() => parseTestgenBundle("no tags here", "042")).toThrow(
      /missing a <test_file>/
    );
  });

  it("[sc#65] graceful-degrade: full mode missing <ui_test_file> → emit handler-only when test_file IS present", () => {
    const raw = `
<test_file>import { POST } from "@/app/api/foo/route";</test_file>
<stub path="src/app/api/foo/route.ts">export async function POST() { return new Response(); }</stub>
`;
    const b = parseTestgenBundle(raw, "042", "full");
    expect(b.testContent).toContain("POST");
    expect(b.uiTestContent).toBe("");
  });

  it("[sc#65] graceful-degrade: full mode missing <test_file> → emit ui-only when ui_test_file IS present", () => {
    const pragmaComment = "// @" + "vitest-environment jsdom";
    const raw = `
<ui_test_file>${pragmaComment}
import { it } from "vitest";</ui_test_file>
`;
    const b = parseTestgenBundle(raw, "042", "full");
    expect(b.uiTestContent).toContain("vitest");
    expect(b.testContent).toBe("");
  });

  it("[sc#65] still throws when BOTH blocks missing in full mode", () => {
    expect(() => parseTestgenBundle("<page_link><page>x</page></page_link>", "042", "full"))
      .toThrow(/missing a <test_file>/);
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

  it("[changed in α.28 / sc#65] full mode degrades gracefully when one block missing", () => {
    // Was throw-on-missing pre-α.28. Now degrades to whichever bundle IS
    // present + warns so the dev sees the LLM's miss. Only throws when
    // BOTH blocks are absent (covered by the dedicated test above).
    const handlerOnly = `<test_file>handler</test_file>`;
    const fromHandler = parseTestgenBundle(handlerOnly, "042", "full");
    expect(fromHandler.testContent).toContain("handler");
    expect(fromHandler.uiTestContent).toBe("");

    const uiOnly = `<ui_test_file>ui</ui_test_file>`;
    const fromUi = parseTestgenBundle(uiOnly, "042", "full");
    expect(fromUi.uiTestContent).toContain("ui");
    expect(fromUi.testContent).toBe("");
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

  it("parses a <page_link> block when present", () => {
    const raw = `
<test_file>t</test_file>
<page_link>
  <page>src/app/(main)/profile/page.tsx</page>
  <component>ProfileEditForm</component>
  <import_from>@/components/profile/ProfileEditForm</import_from>
</page_link>
`;
    const b = parseTestgenBundle(raw, "042");
    expect(b.pageLink).toEqual({
      page: "src/app/(main)/profile/page.tsx",
      component: "ProfileEditForm",
      importFrom: "@/components/profile/ProfileEditForm",
    });
  });

  it("returns pageLink=null when the block is missing or malformed", () => {
    expect(parseTestgenBundle(`<test_file>t</test_file>`, "042").pageLink).toBeNull();
    const missingFields = `<test_file>t</test_file>
<page_link><page>x</page></page_link>`;
    expect(parseTestgenBundle(missingFields, "042").pageLink).toBeNull();
  });
});

// ----------------------------------------------------------------
// 0.7.17 — pipeline-gap assertions
// ----------------------------------------------------------------

describe("normalizeSpecId — 0.7.17 --spec input fix", () => {
  it("strips leading story- prefix", () => {
    expect(normalizeSpecId("story-005")).toBe("005");
    expect(normalizeSpecId("Story-005")).toBe("005");
  });

  it("leaves bare ids untouched", () => {
    expect(normalizeSpecId("005")).toBe("005");
    expect(normalizeSpecId("abc")).toBe("abc");
  });
});

describe("extractDdlColumnsFromInvariants", () => {
  it("extracts `Migration adds profiles.foo ...` shape", () => {
    const cols = extractDdlColumnsFromInvariants([
      "Migration adds `profiles.handle_confirmed boolean not null default false`",
      "Migration adds `profiles.handle_changed_at timestamptz` (nullable)",
    ]);
    expect(cols).toEqual(["handle_confirmed", "handle_changed_at"]);
  });

  it("extracts `add column foo bar` shape", () => {
    const cols = extractDdlColumnsFromInvariants([
      "alter table profiles add column handle text",
    ]);
    expect(cols).toEqual(["handle"]);
  });

  it("dedupes across invariants", () => {
    const cols = extractDdlColumnsFromInvariants([
      "Migration adds `profiles.foo boolean`",
      "alter table profiles add column foo text",
    ]);
    expect(cols).toEqual(["foo"]);
  });

  it("returns [] when no DDL shape is present", () => {
    expect(extractDdlColumnsFromInvariants(["just prose", "and more"])).toEqual([]);
  });

  it("0.7.18: matches `table.column` when a DDL keyword is in the same string (story-005 shape)", () => {
    expect(
      extractDdlColumnsFromInvariants([
        "`profiles.handle` column exists, is unique, and is populated for every profile (backfill migration part of this story)",
      ])
    ).toEqual(["handle"]);
  });

  it("0.7.18: skips incidental `table.column` prose without any DDL keyword", () => {
    expect(
      extractDdlColumnsFromInvariants([
        "viewer session includes `profiles.handle` for routing",
      ])
    ).toEqual([]);
  });
});

describe("extractDdlColumnsFromSpec — 0.7.18 field coverage", () => {
  const base = {
    story_id: "005",
    title: "x",
    invariants: [],
    preconditions: [],
    acceptance_scenarios: [],
    api_contracts: [],
    ui_behavior: {},
    non_goals: [],
    supersedes: [],
    source_issue: "#47",
  } as unknown as import("@slowcook-ai/core").Spec;

  it("pulls columns from invariants", () => {
    const spec = {
      ...base,
      invariants: ["Migration adds `profiles.handle_confirmed boolean not null`"],
    } as unknown as import("@slowcook-ai/core").Spec;
    expect(extractDdlColumnsFromSpec(spec)).toEqual(["handle_confirmed"]);
  });

  it("pulls columns from preconditions (story-005 shape)", () => {
    const spec = {
      ...base,
      preconditions: [
        "`profiles.handle` column exists, is unique, and is populated for every profile (backfill migration part of this story)",
      ],
    } as unknown as import("@slowcook-ai/core").Spec;
    expect(extractDdlColumnsFromSpec(spec)).toEqual(["handle"]);
  });

  it("pulls columns from acceptance_scenarios", () => {
    const spec = {
      ...base,
      acceptance_scenarios: [
        "Given a migration has been applied that adds `profiles.handle` and backfills it",
      ],
    } as unknown as import("@slowcook-ai/core").Spec;
    expect(extractDdlColumnsFromSpec(spec)).toEqual(["handle"]);
  });

  it("dedupes across fields", () => {
    const spec = {
      ...base,
      invariants: ["Migration adds `profiles.handle`"],
      preconditions: [
        "`profiles.handle` column exists after the backfill migration",
      ],
    } as unknown as import("@slowcook-ai/core").Spec;
    expect(extractDdlColumnsFromSpec(spec)).toEqual(["handle"]);
  });
});

describe("buildSchemaAssertionTestContent", () => {
  const base = {
    story_id: "006",
    title: "x",
    invariants: [],
    acceptance_scenarios: [],
    api_contracts: [],
    ui_behavior: {},
    non_goals: [],
    supersedes: [],
    source_issue: "#47",
  } as unknown as Spec;

  it("returns null when the spec has no DDL invariants", () => {
    expect(buildSchemaAssertionTestContent(base)).toBeNull();
  });

  it("produces a test file with one it() per extracted column", () => {
    const spec = {
      ...base,
      invariants: [
        "Migration adds `profiles.handle_confirmed boolean not null default false`",
        "Migration adds `profiles.handle_changed_at timestamptz`",
      ],
    } as unknown as Spec;
    const r = buildSchemaAssertionTestContent(spec);
    expect(r).not.toBeNull();
    expect(r!.path).toBe("tests/schema/story-006.test.ts");
    expect(r!.contents).toContain('it("migration adds column handle_confirmed"');
    expect(r!.contents).toContain('it("migration adds column handle_changed_at"');
    expect(r!.contents).toContain("supabase/migrations");
  });
});

describe("buildPageLinkTestContent", () => {
  const spec = { story_id: "006" } as unknown as Spec;
  const hint = {
    page: "src/app/(main)/profile/page.tsx",
    component: "ProfileEditForm",
    importFrom: "@/components/profile/ProfileEditForm",
  };

  it("writes the page path + component into the test file", () => {
    const r = buildPageLinkTestContent(spec, hint);
    expect(r.path).toBe("tests/integration/story-006-page.test.ts");
    expect(r.contents).toContain('"src/app/(main)/profile/page.tsx"');
    expect(r.contents).toContain('"ProfileEditForm"');
    expect(r.contents).toContain("page integration");
  });

  it("asserts both import + JSX mount", () => {
    const r = buildPageLinkTestContent(spec, hint);
    expect(r.contents).toContain("imports ");
    expect(r.contents).toContain("mounts <");
  });

  it("0.7.21: resolveImportToSourcePath maps @/ alias to src/", () => {
    expect(resolveImportToSourcePath("@/components/profile/ProfileEditForm")).toBe(
      "src/components/profile/ProfileEditForm.tsx"
    );
    expect(resolveImportToSourcePath("@/components/members/MemberReactionsPage")).toBe(
      "src/components/members/MemberReactionsPage.tsx"
    );
    // Already has an extension — keep it.
    expect(resolveImportToSourcePath("@/lib/util.ts")).toBe("src/lib/util.ts");
    // No @/ prefix — pass through with extension appended.
    expect(resolveImportToSourcePath("relative/path")).toBe("relative/path.tsx");
  });

  it("0.7.21: buildStylingPresenceTestContent emits static source-scan assertions", () => {
    const spec = { story_id: "006" } as unknown as import("@slowcook-ai/core").Spec;
    const hint = {
      page: "src/app/(main)/profile/page.tsx",
      component: "ProfileEditForm",
      importFrom: "@/components/profile/ProfileEditForm",
    };
    const r = buildStylingPresenceTestContent(spec, hint);
    expect(r.path).toBe("tests/integration/story-006-styling.test.ts");
    expect(r.contents).toContain('"src/components/profile/ProfileEditForm.tsx"');
    expect(r.contents).toContain("component file exists");
    expect(r.contents).toContain("uses className attributes");
    expect(r.contents).toContain("design-token family");
    // No rendering — pure source scan. Shouldn't import renderWithProviders.
    expect(r.contents).not.toContain("renderWithProviders");
    // String broken up so Vitest's parser doesn't treat it as a real
    // per-file pragma and try to load jsdom for this assertion.
    expect(r.contents).not.toContain("@vitest" + "-environment jsdom");
  });

  it("0.7.19: it() names are STATIC string literals so manifest extraction matches vitest runtime", () => {
    const r = buildPageLinkTestContent(spec, hint);
    // The full names must appear verbatim (no string concatenation in the
    // emitted `it()` call), otherwise the manifest's static ID walk
    // records a truncated name that diverges from vitest's runtime ID →
    // MANIFEST_DRIFT halt on brew.
    expect(r.contents).toContain(
      '"imports ProfileEditForm from @/components/profile/ProfileEditForm"'
    );
    expect(r.contents).toContain('"mounts <ProfileEditForm /> in the rendered tree"');
    // And the dynamic form must NOT appear.
    expect(r.contents).not.toMatch(/"imports " \+ /);
    expect(r.contents).not.toMatch(/"mounts <" \+ /);
  });

  it("0.12.11: schema-presence handles multi-column ALTER TABLE (alter table foo add column a, add column b)", () => {
    // Regression for the false positive observed on rewo's 00017
    // story-006 migration:
    //   alter table profiles
    //     add column handle_confirmed boolean not null default false,
    //     add column handle_changed_at timestamptz;
    // 0.12.10's regex anchored "add column" right after "alter table foo",
    // missing the second column. 0.12.11 splits the check into
    // (statement match) + (any add-column-of-name inside).
    const r = buildSchemaPresenceTestContent({ story_id: "regression" } as unknown as Spec);
    // Captures the entire ALTER TABLE statement body up to its `;`.
    expect(r.contents).toContain("alterStmtRe");
    expect(r.contents).toContain("([\\\\s\\\\S]*?);");
    // Then iterates the matches, applying a separate add-column regex
    // to each statement body.
    expect(r.contents).toContain("alterStmtRe.exec(sql)");
    expect(r.contents).toContain("addRe.test(stmt[1])");
    // Single-column ALTER TABLEs still match (the same alterStmtRe
    // captures `add column foo timestamptz;` as the body).
    expect(r.contents).toContain("(?:if\\\\s+not\\\\s+exists\\\\s+)?");
  });

  it("0.12.10 (slowcook#7): buildSchemaPresenceTestContent emits a column-presence assertion test file", () => {
    const r = buildSchemaPresenceTestContent({ story_id: "042" } as unknown as Spec);
    expect(r.path).toBe("tests/schema/story-042-column-presence.test.ts");
    // The describe wrapper carries the story id so the manifest can
    // attribute the assertion to a story.
    expect(r.contents).toContain('describe("story-042 column presence (code → schema)"');
    // Title is a static literal so manifest extraction matches vitest
    // runtime (same MANIFEST_DRIFT-safe pattern as page-link).
    expect(r.contents).toContain(
      '"every literal .from(t).select(...) column reference exists in supabase/migrations/"'
    );
    // Reads supabase/migrations not just one file
    expect(r.contents).toContain('"supabase/migrations"');
    // Walks src/ recursively, not just src/app
    expect(r.contents).toContain('walkSrc("src", srcFiles)');
    // Skips wildcard selects + computed-table skips
    expect(r.contents).toContain('colsStr.trim() === "*"');
    expect(r.contents).toContain('colsStr.includes("${")');
    // Only validates against tables it has seen in CREATE TABLE — views
    // / RPC tables aren't false-positives.
    expect(r.contents).toContain("knownTables");
  });

  it("0.12.9 (slowcook#6): emits a fetch-URL resolution check for the component", () => {
    const r = buildPageLinkTestContent(spec, hint);
    // Static title + the component path inlined as a string literal
    // (so the check reads the component source at runtime, not via
    // dynamic resolution).
    expect(r.contents).toContain(
      '"every literal fetch(\'/api/...\') URL in ProfileEditForm resolves to a route file"'
    );
    expect(r.contents).toContain('"src/components/profile/ProfileEditForm.tsx"');
    // Asserts route file presence under src/app/, not just any path.
    expect(r.contents).toContain('"src/app" + url + "/route.ts"');
    expect(r.contents).toContain('"src/app" + url + "/route.tsx"');
    // Skips template-literal URLs for v1 (dynamic-segment resolution
    // deferred). Keep this assertion so a future "drop the skip" change
    // is caught here and the limitation is explicit.
    expect(r.contents).toContain('after.startsWith("${")');
  });
});

describe("validateImportClosure (α.49 — delgoosh#656 regression)", () => {
  function mkRepo(): string {
    return mkdtempSync(join(tmpdir(), "slowcook-importclosure-"));
  }

  it("returns no violations when every relative import resolves on disk", () => {
    const r = mkRepo();
    try {
      mkdirSync(join(r, "tests/integration"), { recursive: true });
      mkdirSync(join(r, "tests/helpers/mocks"), { recursive: true });
      writeFileSync(join(r, "tests/helpers/mocks/index.ts"), "export const resetMocks = () => {};", "utf8");
      const src = `import { resetMocks } from "../helpers/mocks";\n`;
      const v = validateImportClosure({
        repoRoot: r,
        testFilePath: "tests/integration/story-3.test.ts",
        testContent: src,
        emittedHelperPaths: [],
      });
      expect(v).toEqual([]);
    } finally {
      rmSync(r, { recursive: true, force: true });
    }
  });

  it("returns no violations when the import resolves to a helper emitted in this turn", () => {
    const r = mkRepo();
    try {
      mkdirSync(join(r, "tests/integration"), { recursive: true });
      // No file on disk — but emit the helper this turn.
      const src = `import { mockFetch } from "../helpers/mocks/fetch";\n`;
      const v = validateImportClosure({
        repoRoot: r,
        testFilePath: "tests/integration/story-3.test.ts",
        testContent: src,
        emittedHelperPaths: ["tests/helpers/mocks/fetch.ts"],
      });
      expect(v).toEqual([]);
    } finally {
      rmSync(r, { recursive: true, force: true });
    }
  });

  it("flags missing helper that is neither emitted nor on disk (the delgoosh#656 case)", () => {
    const r = mkRepo();
    try {
      mkdirSync(join(r, "tests/integration"), { recursive: true });
      const src = `import { resetMocks } from "../helpers/mocks";\n`;
      const v = validateImportClosure({
        repoRoot: r,
        testFilePath: "tests/integration/story-3.test.ts",
        testContent: src,
        emittedHelperPaths: [],
      });
      expect(v).toHaveLength(1);
      expect(v[0]).toEqual({
        test: "tests/integration/story-3.test.ts",
        importPath: "../helpers/mocks",
        reason: "missing",
      });
    } finally {
      rmSync(r, { recursive: true, force: true });
    }
  });

  it("distinguishes 'directory exists but no index' from outright missing", () => {
    const r = mkRepo();
    try {
      mkdirSync(join(r, "tests/integration"), { recursive: true });
      mkdirSync(join(r, "tests/helpers/mocks"), { recursive: true });
      // Directory exists but no index.ts inside.
      const src = `import { resetMocks } from "../helpers/mocks";\n`;
      const v = validateImportClosure({
        repoRoot: r,
        testFilePath: "tests/integration/story-3.test.ts",
        testContent: src,
        emittedHelperPaths: [],
      });
      expect(v).toHaveLength(1);
      expect(v[0]!.reason).toBe("directory-without-index");
    } finally {
      rmSync(r, { recursive: true, force: true });
    }
  });

  it("ignores non-relative imports (@/, bare modules)", () => {
    const r = mkRepo();
    try {
      mkdirSync(join(r, "tests/integration"), { recursive: true });
      const src = `
        import { vi } from "vitest";
        import { Foo } from "@/components/Foo";
        import { bar } from "@tests/helpers/bar";
      `;
      const v = validateImportClosure({
        repoRoot: r,
        testFilePath: "tests/integration/story-3.test.ts",
        testContent: src,
        emittedHelperPaths: [],
      });
      expect(v).toEqual([]);
    } finally {
      rmSync(r, { recursive: true, force: true });
    }
  });

  it("formatImportClosureViolations gives PM-readable bullets with hints", () => {
    const formatted = formatImportClosureViolations([
      { test: "tests/integration/story-3.test.ts", importPath: "../helpers/mocks", reason: "missing" },
      { test: "tests/integration/story-3.test.ts", importPath: "../helpers/db", reason: "directory-without-index" },
    ]);
    expect(formatted).toContain("../helpers/mocks");
    expect(formatted).toContain("vi.clearAllMocks");
    expect(formatted).toContain("../helpers/db");
    expect(formatted).toContain("directory");
    expect(formatted).toContain("emit a `<helper");
  });

  it("a stub emitted this turn also counts as resolved", () => {
    const r = mkRepo();
    try {
      mkdirSync(join(r, "tests/integration"), { recursive: true });
      const src = `import { handler } from "../../src/app/api/foo/route";\n`;
      const v = validateImportClosure({
        repoRoot: r,
        testFilePath: "tests/integration/story-3.test.ts",
        testContent: src,
        emittedHelperPaths: [],
        emittedStubPaths: ["src/app/api/foo/route.ts"],
      });
      expect(v).toEqual([]);
    } finally {
      rmSync(r, { recursive: true, force: true });
    }
  });
});

// ── #240 round-C regression: conventional imports resolve via package roots ──
describe("validateImportClosure workspace fallback", () => {
  it("accepts ../src imports whose target lives in a package root (nodenext .js)", () => {
    const root = mkdtempSync(join(tmpdir(), "tg-ws-"));
    try {
      mkdirSync(join(root, "mock", "src", "pages"), { recursive: true });
      writeFileSync(join(root, "mock", "package.json"), "{}");
      writeFileSync(join(root, "mock", "src", "pages", "BillingRedeemPage.tsx"), "export const x = 1;\n");
      const violations = validateImportClosure({
        repoRoot: root,
        testFilePath: "tests/integration/story-064-ui.test.tsx",
        testContent: 'import { BillingRedeemPage } from "../src/pages/BillingRedeemPage.js";\n',
        emittedHelperPaths: [],
      });
      expect(violations).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// ── sc#240: convention-mining when no context.md exists ──
describe("mineTestExemplars", () => {
  it("excerpts the newest story tests from package roots; null on empty repos", () => {
    const root = mkdtempSync(join(tmpdir(), "tg-mine-"));
    try {
      mkdirSync(join(root, "server", "test"), { recursive: true });
      writeFileSync(join(root, "server", "package.json"), "{}");
      writeFileSync(join(root, "server", "test", "story-068.settlement.test.ts"),
        'import { acceptPOST } from "../src/http/work-sessions.js";\nit("x", () => {});\n');
      const out = mineTestExemplars(root);
      expect(out).toContain("story-068.settlement.test.ts");
      expect(out).toContain("../src/http/work-sessions.js");
      expect(mineTestExemplars(mkdtempSync(join(tmpdir(), "tg-empty-")))).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("collectTargetSpecs force-regenerate mode (D4)", () => {
  function repoWithSpec(uiBehavior: string): string {
    const r = mkdtempSync(join(tmpdir(), "d4-"));
    mkdirSync(join(r, "specs"), { recursive: true });
    mkdirSync(join(r, "tests/integration"), { recursive: true });
    writeFileSync(
      join(r, "specs", "_index.yaml"),
      `schema_version: 1\nstories:\n  "019":\n    title: backend-only story\n    status: active\n`
    );
    writeFileSync(
      join(r, "specs", "story-019.yaml"),
      [
        `story_id: "019"`,
        `title: backend-only story`,
        `status: active`,
        `created_at: "2026-08-21"`,
        `supersedes: []`,
        `superseded_by: null`,
        `actors: []`,
        `preconditions: []`,
        `invariants: []`,
        `acceptance_scenarios: []`,
        `non_goals: []`,
        uiBehavior,
      ]
        .filter(Boolean)
        .join("\n") + "\n"
    );
    // Existing handler tests -> the explicit --spec path is a force re-emit.
    writeFileSync(join(r, "tests/integration", "story-019.test.ts"), "// existing\n");
    return r;
  }
  const ctxFor = (repoRoot: string) =>
    ({ repoRoot, specId: "019", all: false }) as unknown as Parameters<typeof collectTargetSpecs>[0];

  it("backend-only spec re-emits handler-only, never full", () => {
    const targets = collectTargetSpecs(ctxFor(repoWithSpec("")));
    expect(targets).toHaveLength(1);
    expect(targets[0]!.mode).toBe("handler-only");
  });

  it("spec with ui_behavior (both tests on disk) re-emits full", () => {
    const r = repoWithSpec(`ui_behavior:\n  page: shows the merge result`);
    writeFileSync(join(r, "tests/integration", "story-019-ui.test.tsx"), "// existing\n");
    const targets = collectTargetSpecs(ctxFor(r));
    expect(targets[0]!.mode).toBe("full");
  });
});
