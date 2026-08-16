import { describe, it, expect } from "vitest";
import { globToRegExp, parseRungMarkers, assignRungs } from "./manifest.js";

/**
 * 0.11.18+ — `slowcook manifest record --story <id>` now filters
 * discovered tests to those belonging to the given story.
 *
 * The filter is implemented inside the manifest command using a
 * file-pattern regex. We test the regex shape directly here because
 * it's the load-bearing piece — the rest of the flow is just I/O
 * (read stack-config, run discover_command, write JSON).
 */

function storyFilterFor(storyId: string): RegExp {
  return new RegExp(
    `(?:^|/)story-${storyId.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\$&")}(?:[-.]|$)`
  );
}

describe("manifest --story filter (0.11.18)", () => {
  it("matches the story's own test files", () => {
    const re = storyFilterFor("007");
    expect(re.test("tests/integration/story-007.test.ts")).toBe(true);
    expect(re.test("tests/integration/story-007-ui.test.tsx")).toBe(true);
    expect(re.test("tests/integration/story-007-page.test.ts")).toBe(true);
    expect(re.test("tests/integration/story-007-styling.test.ts")).toBe(true);
    expect(re.test("tests/schema/story-007.test.ts")).toBe(true);
  });

  it("rejects other stories' test files", () => {
    const re = storyFilterFor("007");
    expect(re.test("tests/integration/story-006.test.ts")).toBe(false);
    expect(re.test("tests/integration/story-006-ui.test.tsx")).toBe(false);
    expect(re.test("tests/integration/story-001-styling.test.ts")).toBe(false);
    expect(re.test("tests/integration/story-009.test.ts")).toBe(false);
  });

  it("rejects prefix-collisions (story-007 vs story-0070)", () => {
    const re = storyFilterFor("007");
    expect(re.test("tests/integration/story-0070.test.ts")).toBe(false);
    expect(re.test("tests/integration/story-007a.test.ts")).toBe(false);
  });

  it("rejects unrelated files (helpers, src, lib)", () => {
    const re = storyFilterFor("007");
    expect(re.test("src/lib/links/normalize.test.ts")).toBe(false);
    expect(re.test("tests/integration/phase-a-smoke.test.tsx")).toBe(false);
    expect(re.test("tests/helpers/render.tsx")).toBe(false);
  });

  it("works for non-numeric story ids (defensive)", () => {
    const re = storyFilterFor("abc");
    expect(re.test("tests/integration/story-abc.test.ts")).toBe(true);
    expect(re.test("tests/integration/story-abcd.test.ts")).toBe(false);
  });
});

// dovizir handover §9 — `story-<id>` in the filename is a stack-ts naming
// convention. Foundry suites (`*.t.sol`) match nothing, so `--story N`
// refused to write and the live workaround was hand-editing the manifest.
describe("globToRegExp (--match, dovizir §9)", () => {
  it("matches a Foundry suite by glob where the story-name convention cannot", () => {
    const re = globToRegExp("**/Wallet*.t.sol");
    expect(re.test("test/WalletDeposit.t.sol")).toBe(true);
    expect(re.test("packages/acceptance/test/WalletWithdraw.t.sol")).toBe(true);
    expect(re.test("test/Vault.t.sol")).toBe(false);
  });

  it("* does not cross a path separator; ** does", () => {
    expect(globToRegExp("test/*.t.sol").test("test/A.t.sol")).toBe(true);
    expect(globToRegExp("test/*.t.sol").test("test/deep/A.t.sol")).toBe(false);
    expect(globToRegExp("test/**/*.t.sol").test("test/deep/A.t.sol")).toBe(true);
  });

  it("treats dots literally rather than as any-char", () => {
    expect(globToRegExp("*.t.sol").test("AxtysolX")).toBe(false);
    expect(globToRegExp("*.t.sol").test("A.t.sol")).toBe(true);
  });
});

// P4 — rung markers → release_order (ladder mode's ordering source).
describe("parseRungMarkers + assignRungs", () => {
  const file = `
// ordering rationale: smoke first, invariants pin the shape
// @slowcook-rung 1 — smoke
describe("story-009 smoke — module loads", () => {});
// @slowcook-rung 2
describe("story-009 invariants", () => {});
it("unmarked straggler", () => {});
`;
  it("parses rung + the annotated title", () => {
    const m = parseRungMarkers(file);
    expect(m).toEqual([
      { rung: 1, title: "story-009 smoke — module loads" },
      { rung: 2, title: "story-009 invariants" },
    ]);
  });
  it("assigns by title-fragment match; unmarked tests get no order (released immediately)", () => {
    const tests = [
      { id: "t.ts > story-009 smoke — module loads > boots", file: "t.ts" },
      { id: "t.ts > story-009 invariants > wallet never negative", file: "t.ts" },
      { id: "t.ts > unmarked straggler", file: "t.ts" },
    ];
    const out = assignRungs(tests, new Map([["t.ts", parseRungMarkers(file)]]));
    expect(out[0]!.release_order).toBe(1);
    expect(out[1]!.release_order).toBe(2);
    expect(out[2]!.release_order).toBeUndefined();
  });
});
