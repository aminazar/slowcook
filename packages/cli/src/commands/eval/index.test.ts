import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadFixture,
  listFixtureIds,
  runFixture,
  type Fixture,
} from "./index.js";

function setupTmpFixtures(): string {
  return mkdtempSync(join(tmpdir(), "slowcook-eval-"));
}

function writeFixture(root: string, id: string, body: unknown): void {
  const dir = join(root, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "fixture.json"), JSON.stringify(body, null, 2), "utf8");
}

describe("eval / listFixtureIds", () => {
  let root: string;
  beforeEach(() => {
    root = setupTmpFixtures();
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("returns ids sorted, ignoring non-directory entries", () => {
    writeFixture(root, "zebra", { id: "zebra" });
    writeFixture(root, "apple", { id: "apple" });
    writeFileSync(join(root, "stray.txt"), "not a fixture");
    expect(listFixtureIds(root)).toEqual(["apple", "zebra"]);
  });

  it("returns empty when directory does not exist", () => {
    expect(listFixtureIds(join(root, "does-not-exist"))).toEqual([]);
  });

  it("ignores subdirs without fixture.json", () => {
    mkdirSync(join(root, "incomplete"), { recursive: true });
    writeFixture(root, "complete", { id: "complete" });
    expect(listFixtureIds(root)).toEqual(["complete"]);
  });
});

describe("eval / loadFixture validation", () => {
  let root: string;
  beforeEach(() => {
    root = setupTmpFixtures();
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("rejects fixtures with unknown agent", () => {
    writeFixture(root, "x", {
      id: "x",
      agent: "no-such-agent",
      input: {},
      expected_prompt_includes: ["foo"],
    });
    expect(() => loadFixture(root, "x")).toThrow(/unknown agent/);
  });

  it("rejects fixtures with empty includes", () => {
    writeFixture(root, "x", {
      id: "x",
      agent: "chef-orchestrate",
      input: {},
      expected_prompt_includes: [],
    });
    expect(() => loadFixture(root, "x")).toThrow(/at least one substring/);
  });

  it("rejects missing fixture file", () => {
    expect(() => loadFixture(root, "ghost")).toThrow(/not found/);
  });

  it("rejects fixtures with malformed JSON", () => {
    const dir = join(root, "broken");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "fixture.json"), "{ not json", "utf8");
    expect(() => loadFixture(root, "broken")).toThrow(/not valid JSON/);
  });
});

describe("eval / runFixture", () => {
  const baseInput = {
    storyId: "test-1",
    prNumber: 42,
    prState: {
      headRef: "feat/x",
      baseRef: "main",
      state: "OPEN",
      mergeStateStatus: "CLEAN",
      title: "test",
    },
    chefDriftLedger: {
      story_id: "test-1",
      moves: [],
      cumulative_cost_usd: 0,
    },
    navigatorHistory: null,
    spec: { path: "x.yaml", yaml: "id: test-1\n" },
    storyOpenPrs: [],
  };

  it("returns pass when all expected includes are present and excludes are absent", () => {
    const f: Fixture = {
      id: "passing",
      agent: "chef-orchestrate",
      description: "passes",
      input: baseInput,
      expected_prompt_includes: ["story-test-1", "PR #42", "Chef-drift ledger"],
      expected_prompt_excludes: ["TODO", "FIXME"],
    };
    const r = runFixture(f);
    expect(r.status).toBe("pass");
    expect(r.missingIncludes).toEqual([]);
    expect(r.unexpectedExcludes).toEqual([]);
  });

  it("returns fail with missing substring listed", () => {
    const f: Fixture = {
      id: "missing",
      agent: "chef-orchestrate",
      description: "missing context",
      input: baseInput,
      expected_prompt_includes: ["story-test-1", "this-string-will-not-appear-zzzz"],
    };
    const r = runFixture(f);
    expect(r.status).toBe("fail");
    expect(r.missingIncludes).toContain("this-string-will-not-appear-zzzz");
  });

  it("returns fail when a forbidden substring is present", () => {
    const f: Fixture = {
      id: "leaks",
      agent: "chef-orchestrate",
      description: "leaks placeholder",
      input: baseInput,
      expected_prompt_includes: ["story-test-1"],
      // The chef-orchestrate prompt always renders the chefDriftLedger
      // as JSON, so {"story_id" ends up in the output. Asserting
      // "story_id" is forbidden should therefore fail — this proves
      // the exclude check works end-to-end.
      expected_prompt_excludes: ["story_id"],
    };
    const r = runFixture(f);
    expect(r.status).toBe("fail");
    expect(r.unexpectedExcludes).toContain("story_id");
  });

  it("returns error when the prompt builder throws", () => {
    const f: Fixture = {
      id: "explodes",
      agent: "chef-orchestrate",
      description: "missing required fields",
      input: { storyId: "broken" } as Record<string, unknown>,
      expected_prompt_includes: ["something"],
    };
    const r = runFixture(f);
    // The builder may either throw (→ error) or render with undefineds
    // (→ fail). Either way it must NOT report pass.
    expect(r.status).not.toBe("pass");
  });
});
