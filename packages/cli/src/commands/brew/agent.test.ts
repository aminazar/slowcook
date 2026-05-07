import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  findHandler,
  outlineFile,
  parseHaltEnvelope,
  decideNavigatorAction,
  validateProposedTestPath,
  extractNavigatorProposedTest,
} from "./agent.js";
import type { NavigatorHookVerdict } from "./agent.js";

function mkRepo(): string {
  return mkdtempSync(join(tmpdir(), "slowcook-brew-helpers-"));
}

describe("findHandler — Next.js App Router mapping", () => {
  it("maps POST /api/rewos to src/app/api/rewos/route.ts", () => {
    const repo = mkRepo();
    try {
      mkdirSync(join(repo, "src/app/api/rewos"), { recursive: true });
      writeFileSync(join(repo, "src/app/api/rewos/route.ts"), "export async function POST() {}", "utf8");

      const result = findHandler(repo, "POST", "/api/rewos");
      expect(result).toMatchObject({
        framework: "next-app-router",
        file: "src/app/api/rewos/route.ts",
        function: "POST",
        exists: true,
      });
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("normalises :param to [param]", () => {
    const repo = mkRepo();
    try {
      mkdirSync(join(repo, "src/app"), { recursive: true });
      const result = findHandler(repo, "POST", "/api/rewos/:rewo_id/reports");
      expect(result.file).toBe("src/app/api/rewos/[rewo_id]/reports/route.ts");
      expect(result.framework).toBe("next-app-router");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("normalises {param} to [param]", () => {
    const repo = mkRepo();
    try {
      mkdirSync(join(repo, "src/app"), { recursive: true });
      const result = findHandler(repo, "GET", "/api/users/{id}");
      expect(result.file).toBe("src/app/api/users/[id]/route.ts");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("returns exists=false with a create-it note when the route file is missing", () => {
    const repo = mkRepo();
    try {
      mkdirSync(join(repo, "src/app"), { recursive: true });
      const result = findHandler(repo, "POST", "/api/new-route");
      expect(result.exists).toBe(false);
      expect(result.note).toMatch(/does not exist/i);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("returns framework=unknown when src/app/ is absent", () => {
    const repo = mkRepo();
    try {
      const result = findHandler(repo, "POST", "/api/rewos");
      expect(result.framework).toBe("unknown");
      expect(result.exists).toBe(false);
      expect(result.note).toMatch(/no `src\/app\/`/);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("complains when method or path is empty", () => {
    const repo = mkRepo();
    try {
      const result = findHandler(repo, "", "/api/rewos");
      expect(result.framework).toBe("unknown");
      expect(result.note).toMatch(/required/);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});

describe("outlineFile — compact TS outline", () => {
  it("lists imports and top-level exports with line numbers", () => {
    const src = `import { foo } from "./foo";
import type { Bar } from "./bar";

export function POST(req: Request): Promise<Response> {
  return handle(req);
}

export const MAX_RETRIES = 3;

export interface Config {
  timeout: number;
}

function privateHelper() {
  return 42;
}
`;
    const out = outlineFile("src/app/api/rewos/route.ts", src);
    expect(out).toContain("# outline: src/app/api/rewos/route.ts");
    expect(out).toContain('import { foo } from "./foo"');
    expect(out).toContain('import type { Bar } from "./bar"');
    expect(out).toMatch(/L\d+: export function POST/);
    expect(out).toMatch(/L\d+: export const MAX_RETRIES/);
    expect(out).toMatch(/L\d+: export interface Config/);
    // private (unexported) helper should NOT appear — outline surfaces
    // the public API, keeping the output compact.
    // …unless it's top-level, in which case it's still relevant. We include it.
    expect(out).toMatch(/L\d+: function privateHelper/);
  });

  it("handles a file with no imports or exports gracefully", () => {
    const out = outlineFile("src/utils/constants.ts", "// just a comment\n");
    expect(out).toContain("(no imports or top-level declarations detected");
  });

  it("produces an outline much smaller than the source", () => {
    const big = Array.from({ length: 400 }, (_, i) => `  const x${i} = ${i};`).join("\n") +
      "\n\nexport function one() { return 1; }\nexport function two() { return 2; }\n";
    const out = outlineFile("src/big.ts", big);
    // Source is ~6kB+; outline is small and names exactly the exports.
    expect(out.length).toBeLessThan(big.length / 4);
    expect(out).toMatch(/export function one/);
    expect(out).toMatch(/export function two/);
  });
});

describe("parseHaltEnvelope — agent text → halt classification (0.16.0-α.30)", () => {
  it("extracts class + <conflict> body from a well-formed envelope", () => {
    const rationale = `Now I see the conflict.

<halt class="MOCKUP_DESIGN_CONFLICT">
  <test>tests/integration/story-017-ui.test.tsx > "owner clicks Pin"</test>
  <conflict>The test imports MemberReactionsPage but vibe ported MemberReactionsWithPins. Renaming would break story-005 tests that import the same path with old prop shape.</conflict>
  <recommendation>PM should /plate the mock to MemberReactionsPage.</recommendation>
</halt>`;
    const out = parseHaltEnvelope(rationale);
    expect(out).not.toBeNull();
    expect(out!.class).toBe("MOCKUP_DESIGN_CONFLICT");
    expect(out!.summary).toContain("MemberReactionsPage");
    expect(out!.summary).toContain("story-005");
  });

  it("recognises SPEC_AMBIGUITY_DETECTED", () => {
    const rationale = `<halt class="SPEC_AMBIGUITY_DETECTED">
  <conflict>test queries /Pinned/ but mock renders "Saved"</conflict>
</halt>`;
    const out = parseHaltEnvelope(rationale);
    expect(out?.class).toBe("SPEC_AMBIGUITY_DETECTED");
    expect(out?.summary).toContain("Saved");
  });

  it("returns null for unrecognised halt classes (typo defense)", () => {
    const rationale = `<halt class="MOCKUP_DESIGN_CONFLCT">
  <conflict>typo</conflict>
</halt>`;
    expect(parseHaltEnvelope(rationale)).toBeNull();
  });

  it("returns null when no envelope present", () => {
    expect(parseHaltEnvelope("agent reasoning, no halt requested")).toBeNull();
    expect(parseHaltEnvelope("")).toBeNull();
  });

  it("falls back to text inside envelope when <conflict> missing", () => {
    const rationale = `<halt class="TEST_RUNNER_BROKEN">
  Vitest crashed on import; cannot proceed without fixing setup.
</halt>`;
    const out = parseHaltEnvelope(rationale);
    expect(out?.class).toBe("TEST_RUNNER_BROKEN");
    expect(out?.summary).toContain("Vitest crashed");
  });

  it("collapses whitespace + caps summary at 800 chars", () => {
    const long = "x".repeat(2000);
    const rationale = `<halt class="MOCKUP_DESIGN_CONFLICT">
  <conflict>${long}</conflict>
</halt>`;
    const out = parseHaltEnvelope(rationale);
    expect(out?.summary.length).toBe(800);
  });

  it("ignores envelopes embedded in other text (still parses correctly)", () => {
    const rationale = `Lorem ipsum dolor sit amet.

I considered editing src/components/X but it has no marker.

<halt class="MOCKUP_DESIGN_CONFLICT">
  <conflict>name mismatch</conflict>
</halt>

Trailing notes...`;
    const out = parseHaltEnvelope(rationale);
    expect(out?.class).toBe("MOCKUP_DESIGN_CONFLICT");
    expect(out?.summary).toBe("name mismatch");
  });
});

describe("decideNavigatorAction (pair-brew prod hook helper)", () => {
  it("returns approve / 0-cost when verdict is null (no hook configured)", () => {
    const r = decideNavigatorAction(null);
    expect(r.action).toBe("approve");
    expect(r.costUsd).toBe(0);
    expect(r.concernsSummary).toBe("");
  });

  it("returns approve when verdict is approve", () => {
    const v: NavigatorHookVerdict = { overall: "approve", concerns: [] };
    const r = decideNavigatorAction(v);
    expect(r.action).toBe("approve");
    expect(r.concernsSummary).toBe("");
  });

  it("returns block + summary + cost when verdict is block", () => {
    const v: NavigatorHookVerdict = {
      overall: "block",
      concerns: ["mobile breakpoint missing", "cross-story regression risk on /feed"],
      costUsd: 0.0123,
    };
    const r = decideNavigatorAction(v);
    expect(r.action).toBe("block");
    expect(r.costUsd).toBe(0.0123);
    expect(r.concernsSummary).toBe("mobile breakpoint missing; cross-story regression risk on /feed");
  });

  it("caps concerns summary at 5 entries", () => {
    const v: NavigatorHookVerdict = {
      overall: "block",
      concerns: ["c1", "c2", "c3", "c4", "c5", "c6", "c7"],
    };
    const r = decideNavigatorAction(v);
    expect(r.concernsSummary).toBe("c1; c2; c3; c4; c5");
  });

  it("uses '(no concerns text)' fallback when block has empty concerns array", () => {
    const v: NavigatorHookVerdict = { overall: "block", concerns: [] };
    const r = decideNavigatorAction(v);
    expect(r.concernsSummary).toBe("(no concerns text)");
  });

  it("treats missing costUsd as 0", () => {
    const v: NavigatorHookVerdict = { overall: "approve", concerns: [] };
    const r = decideNavigatorAction(v);
    expect(r.costUsd).toBe(0);
  });

  it("preserves costUsd on approve verdicts (still tallies budget)", () => {
    const v: NavigatorHookVerdict = { overall: "approve", concerns: [], costUsd: 0.005 };
    const r = decideNavigatorAction(v);
    expect(r.action).toBe("approve");
    expect(r.costUsd).toBe(0.005);
  });
});

describe("validateProposedTestPath (#77 navigator-emitted test gate)", () => {
  it("accepts a path under tests/navigator/ ending in .test.ts", () => {
    const r = validateProposedTestPath("tests/navigator/iter-3-mobile.test.ts");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.path).toBe("tests/navigator/iter-3-mobile.test.ts");
  });

  it("accepts .test.tsx as well", () => {
    const r = validateProposedTestPath("tests/navigator/responsive.test.tsx");
    expect(r.ok).toBe(true);
  });

  it("rejects empty path", () => {
    const r = validateProposedTestPath("");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/empty/);
  });

  it("rejects absolute path", () => {
    const r = validateProposedTestPath("/etc/passwd.test.ts");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/absolute/);
  });

  it("rejects '..' segments", () => {
    const r = validateProposedTestPath("tests/navigator/../escape.test.ts");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/'\.\.'/);
  });

  it("rejects path outside tests/navigator/", () => {
    const r = validateProposedTestPath("tests/integration/iter.test.ts");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/tests\/navigator/);
  });

  it("rejects path that doesn't end in .test.ts(x)", () => {
    const r = validateProposedTestPath("tests/navigator/foo.ts");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/\.test\.ts/);
  });
});

describe("extractNavigatorProposedTest (#77)", () => {
  it("returns null for null verdict", () => {
    expect(extractNavigatorProposedTest(null)).toBeNull();
  });

  it("returns null for verdict without proposedTest", () => {
    const v: NavigatorHookVerdict = { overall: "block", concerns: ["x"] };
    expect(extractNavigatorProposedTest(v)).toBeNull();
  });

  it("returns null for approve verdict (even with proposedTest — defensive)", () => {
    const v: NavigatorHookVerdict = {
      overall: "approve",
      concerns: [],
      proposedTest: { path: "tests/navigator/x.test.ts", content: "test stuff" },
    };
    expect(extractNavigatorProposedTest(v)).toBeNull();
  });

  it("returns the file payload for valid block + proposedTest", () => {
    const v: NavigatorHookVerdict = {
      overall: "block",
      concerns: ["mobile breakpoint"],
      proposedTest: {
        path: "tests/navigator/iter-3-mobile.test.ts",
        content: "import { test } from 'vitest';\ntest('mobile', () => {});\n",
      },
    };
    const r = extractNavigatorProposedTest(v);
    expect(r).not.toBeNull();
    expect(r?.path).toBe("tests/navigator/iter-3-mobile.test.ts");
    expect(r?.content).toContain("import { test }");
  });

  it("rejects proposedTest with bad path", () => {
    const v: NavigatorHookVerdict = {
      overall: "block",
      concerns: ["x"],
      proposedTest: { path: "tests/integration/sneaky.test.ts", content: "..." },
    };
    expect(extractNavigatorProposedTest(v)).toBeNull();
  });

  it("rejects proposedTest with empty content", () => {
    const v: NavigatorHookVerdict = {
      overall: "block",
      concerns: ["x"],
      proposedTest: { path: "tests/navigator/empty.test.ts", content: "" },
    };
    expect(extractNavigatorProposedTest(v)).toBeNull();
  });
});
