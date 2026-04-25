import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  normaliseBugId,
  renderRegressionStub,
  loadBugProfile,
} from "./index.js";
import { renderProfileAsYaml } from "../investigate/index.js";
import { type BugProfile, BUG_PROFILE_SCHEMA_VERSION } from "../investigate/schema.js";

function makeProfile(): BugProfile {
  return {
    schema_version: BUG_PROFILE_SCHEMA_VERSION,
    bug_id: "B-1",
    title: "/feed reactor names not hyperlinked",
    source_issue: "#135",
    status: "investigated",
    investigated_by: "slowcook-investigate@0.13.0-alpha.2b",
    created_at: "2026-04-25T22:00:00.000Z",
    symptom: ["Names render as plain text on /feed despite story-013 brew."],
    expected: ["Each name should be a Link to /u/<handle>."],
    reproduction: ["Load /feed as authenticated user."],
    failure_locus: {
      file: "src/app/api/feed/connections/route.ts",
      line: 38,
      function: "GET",
      diagnosis:
        "Selects (id, display_name) from profiles but FeedPage reads member.handle.",
    },
    regression_assertion: [
      "Given a connection-reaction row, when /feed renders, then the reactor name links to /u/<handle>.",
    ],
    fix_scope: ["src/app/api/feed/connections/route.ts"],
  };
}

function mkRepo(): string {
  return mkdtempSync(join(tmpdir(), "slowcook-recipe-regression-"));
}

describe("normaliseBugId", () => {
  it("accepts plain numbers and adds the B- prefix", () => {
    expect(normaliseBugId("1")).toBe("B-1");
    expect(normaliseBugId("42")).toBe("B-42");
  });
  it("accepts the canonical B-N form unchanged", () => {
    expect(normaliseBugId("B-1")).toBe("B-1");
    expect(normaliseBugId("B-42")).toBe("B-42");
  });
  it("accepts the dashless form B<n>", () => {
    expect(normaliseBugId("B1")).toBe("B-1");
    expect(normaliseBugId("b42")).toBe("B-42");
  });
  it("returns the raw value for non-matching input", () => {
    expect(normaliseBugId("nonsense")).toBe("nonsense");
  });
});

describe("renderRegressionStub", () => {
  it("emits a tests/regression/B-<id>-<slug>.test.ts file path", () => {
    const r = renderRegressionStub(makeProfile(), "0.13.0-alpha.3");
    expect(r.path).toBe(
      "tests/regression/B-1-feed-reactor-names-not-hyperlinked.test.ts"
    );
  });

  it("includes the bug profile path + source issue in the header", () => {
    const r = renderRegressionStub(makeProfile(), "0.13.0-alpha.3");
    expect(r.contents).toContain(".brewing/bug-profiles/B-1.yaml");
    expect(r.contents).toContain("#135");
  });

  it("emits one `it` per regression_assertion", () => {
    const profile = makeProfile();
    profile.regression_assertion = ["assertion A", "assertion B", "assertion C"];
    const r = renderRegressionStub(profile, "0.13.0-alpha.3");
    const itCount = (r.contents.match(/^\s*it\(/gm) ?? []).length;
    expect(itCount).toBe(3);
    expect(r.contents).toContain('it("assertion A"');
    expect(r.contents).toContain('it("assertion B"');
    expect(r.contents).toContain('it("assertion C"');
  });

  it("calls expect.fail in each it body so the test is red until sift fixes it", () => {
    const r = renderRegressionStub(makeProfile(), "0.13.0-alpha.3");
    expect(r.contents).toContain("expect.fail(");
  });

  it("includes the failure_locus + diagnosis as code comments for the developer", () => {
    const r = renderRegressionStub(makeProfile(), "0.13.0-alpha.3");
    expect(r.contents).toContain("src/app/api/feed/connections/route.ts");
    expect(r.contents).toContain("// Diagnosis:");
  });

  it("escapes special characters in test names", () => {
    const profile = makeProfile();
    profile.regression_assertion = [
      'A test with "quotes" inside',
    ];
    const r = renderRegressionStub(profile, "0.13.0-alpha.3");
    // JSON.stringify produces "A test with \"quotes\" inside"
    expect(r.contents).toContain('it("A test with \\"quotes\\" inside"');
  });

  it("slugifies the title to a kebab-case path", () => {
    const profile = makeProfile();
    profile.title = "Has Some_Special! Chars & Spaces";
    const r = renderRegressionStub(profile, "0.13.0-alpha.3");
    expect(r.path).toMatch(/^tests\/regression\/B-1-has-some-special-chars-spaces\.test\.ts$/);
  });

  it("truncates very long titles in the slug", () => {
    const profile = makeProfile();
    profile.title = "x".repeat(200);
    const r = renderRegressionStub(profile, "0.13.0-alpha.3");
    // 60-char limit on slug.
    const slug = r.path.replace(/^tests\/regression\/B-1-|\.test\.ts$/g, "");
    expect(slug.length).toBeLessThanOrEqual(60);
  });
});

describe("loadBugProfile", () => {
  it("reads + validates a profile YAML round-trip", () => {
    const repo = mkRepo();
    try {
      const dir = join(repo, ".brewing/bug-profiles");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "B-1.yaml"), renderProfileAsYaml(makeProfile()));
      const loaded = loadBugProfile(repo, "B-1");
      expect(loaded.bug_id).toBe("B-1");
      expect(loaded.title).toBe("/feed reactor names not hyperlinked");
      expect(loaded.failure_locus.line).toBe(38);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("throws a clear error when the profile is missing", () => {
    const repo = mkRepo();
    try {
      expect(() => loadBugProfile(repo, "B-99")).toThrow(/not found/);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});
