import { describe, it, expect } from "vitest";

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
