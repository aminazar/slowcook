// Ratchet protection: an artifact may only be changed by the agent that owns
// it, initiated by a correctly labelled issue. No hand-edit route.
import { describe, it, expect } from "vitest";
import {
  ruleFor, verifyProtection, renderVerdict, DEFAULT_OWNERSHIP,
  type ProtectionInput, type OwnershipConfig,
} from "./ratchet-protection.js";

const MANIFEST = ["tests/integration/story-001.test.ts", "test/IouToken.t.sol"];

// dash's rule, to prove ownership is configuration rather than baked policy.
const CONFIG: OwnershipConfig = {
  rules: [
    ...DEFAULT_OWNERSHIP.rules,
    { artifact: "stories", paths: ["docs/stories/"], agent: "pm-assistant", issue_label: "pm:story-change" },
  ],
};

const base = (over: Partial<ProtectionInput> = {}): ProtectionInput => ({
  changedPaths: [],
  headHashes: {},
  ledger: [],
  baseline: { commit: "abc123", at: "2026-08-22T00:00:00Z", by: "amin" },
  config: CONFIG,
  manifestTestFiles: MANIFEST,
  ...over,
});

const authored = (agent: string, path: string, hash: string, over: Record<string, unknown> = {}) => ({
  agent, files: [path], hashes: { [path]: hash },
  issue: 42, issue_labels: ["agent:recipe"], at: "now", ...over,
});

describe("ruleFor", () => {
  it("maps each artifact class to its owner", () => {
    expect(ruleFor("tests/integration/story-001.test.ts", CONFIG, MANIFEST)?.agent).toBe("recipe");
    expect(ruleFor("specs/story-001.yaml", CONFIG, MANIFEST)?.agent).toBe("refine");
    expect(ruleFor("docs/stories/042.md", CONFIG, MANIFEST)?.agent).toBe("pm-assistant");
  });

  it("owns nothing else — unowned code stays hand-editable", () => {
    expect(ruleFor("src/cart.ts", CONFIG, MANIFEST)).toBeNull();
    expect(ruleFor("README.md", CONFIG, MANIFEST)).toBeNull();
    // A repo's OWN unit tests are not the story oracle.
    expect(ruleFor("packages/cli/src/foo.test.ts", CONFIG, MANIFEST)).toBeNull();
  });
});

describe("verifyProtection", () => {
  it("passes a PR that touches no owned artifact", () => {
    expect(verifyProtection(base({ changedPaths: ["src/cart.ts"] })).ok).toBe(true);
  });

  it("BLOCKS a hand-edited test — there is no override route", () => {
    const v = verifyProtection(base({
      changedPaths: ["tests/integration/story-001.test.ts"],
      headHashes: { "tests/integration/story-001.test.ts": "x" },
    }));
    expect(v.ok).toBe(false);
    expect(v.violations[0]!.reason).toContain("owned by `recipe`");
    expect(v.violations[0]!.reason).toContain("agent:recipe");
  });

  it("allows a test authored by recipe from a correctly labelled issue", () => {
    const p = "tests/integration/story-001.test.ts";
    const v = verifyProtection(base({
      changedPaths: [p], headHashes: { [p]: "h1" },
      ledger: [authored("recipe", p, "h1")],
    }));
    expect(v.ok).toBe(true);
    expect(v.sanctioned[0]).toMatchObject({ agent: "recipe", via: "issue #42" });
  });

  it("BLOCKS the WRONG agent — owning tests does not grant rights over specs", () => {
    const p = "specs/story-001.yaml";
    const v = verifyProtection(base({
      changedPaths: [p], headHashes: { [p]: "h1" },
      ledger: [authored("recipe", p, "h1", { issue_labels: ["agent:refine"] })],
    }));
    expect(v.ok).toBe(false);
    expect(v.violations[0]!.reason).toContain("authored by `recipe`");
    expect(v.violations[0]!.reason).toContain("owned by `refine`");
  });

  it("BLOCKS an agent-authored file that was then hand-edited in the same PR", () => {
    const p = "tests/integration/story-001.test.ts";
    const v = verifyProtection(base({
      changedPaths: [p], headHashes: { [p]: "EDITED" },
      ledger: [authored("recipe", p, "h1")],
    }));
    expect(v.ok).toBe(false);
    expect(v.violations[0]!.reason).toContain("differs from what it wrote");
  });

  it("BLOCKS a run with no driving issue", () => {
    const p = "tests/integration/story-001.test.ts";
    const v = verifyProtection(base({
      changedPaths: [p], headHashes: { [p]: "h1" },
      ledger: [authored("recipe", p, "h1", { issue: undefined })],
    }));
    expect(v.ok).toBe(false);
    expect(v.violations[0]!.reason).toContain("neither a driving issue nor a recorded derived trigger");
  });

  it("BLOCKS when the driving ISSUE lacks the owner's label", () => {
    // Checked on the issue, not the PR — so it cannot be added after the fact
    // by whoever opened the PR.
    const p = "tests/integration/story-001.test.ts";
    const v = verifyProtection(base({
      changedPaths: [p], headHashes: { [p]: "h1" },
      ledger: [authored("recipe", p, "h1", { issue_labels: ["bug"] })],
    }));
    expect(v.ok).toBe(false);
    expect(v.violations[0]!.reason).toContain("does not carry `agent:recipe`");
    expect(v.violations[0]!.reason).toContain("not the PR");
  });

  it("refine may change a spec only when the story consented", () => {
    const p = "specs/story-001.yaml";
    const without = verifyProtection(base({
      changedPaths: [p], headHashes: { [p]: "h1" },
      ledger: [authored("refine", p, "h1", { issue_labels: ["agent:refine"] })],
    }));
    expect(without.ok).toBe(false);
    expect(without.violations[0]!.reason).toContain("story agrees");

    const withConsent = verifyProtection(base({
      changedPaths: [p], headHashes: { [p]: "h1" },
      ledger: [authored("refine", p, "h1", {
        issue_labels: ["agent:refine"],
        story_consent: { story_id: "001", evidence: "#42 comment" },
      })],
    }));
    expect(withConsent.ok).toBe(true);
  });

  it("applies to any configured artifact — dash stories belong to pm-assistant", () => {
    const p = "docs/stories/042.md";
    const bad = verifyProtection(base({ changedPaths: [p], headHashes: { [p]: "h1" } }));
    expect(bad.ok).toBe(false);
    expect(bad.violations[0]!.reason).toContain("pm-assistant");

    const good = verifyProtection(base({
      changedPaths: [p], headHashes: { [p]: "h1" },
      ledger: [authored("pm-assistant", p, "h1", { issue_labels: ["pm:story-change"] })],
    }));
    expect(good.ok).toBe(true);
  });

  it("judges each file alone — one authorised file cannot launder a rogue one", () => {
    const ok = "tests/integration/story-001.test.ts";
    const rogue = "specs/story-001.yaml";
    const v = verifyProtection(base({
      changedPaths: [ok, rogue], headHashes: { [ok]: "h1", [rogue]: "h2" },
      ledger: [authored("recipe", ok, "h1")],
    }));
    expect(v.ok).toBe(false);
    expect(v.sanctioned).toHaveLength(1);
    expect(v.violations.map((x) => x.path)).toEqual([rogue]);
  });
});

describe("renderVerdict", () => {
  it("says why there is no override, not just that it failed", () => {
    const out = renderVerdict(verifyProtection(base({
      changedPaths: ["tests/integration/story-001.test.ts"],
      headHashes: { "tests/integration/story-001.test.ts": "x" },
    })));
    expect(out).toContain("✗ ratchet-protection");
    expect(out).toContain("no hand-edit route");
    expect(out).toContain("same PR that claims");
  });
});


describe("baseline + derived triggers (2026-08-22 rulings)", () => {
  const PATH = "tests/integration/story-001.test.ts";

  it("owned change with NO baseline = baseline-missing setup failure, with the init instruction", () => {
    const v = verifyProtection(base({
      baseline: null,
      changedPaths: [PATH],
      headHashes: { [PATH]: "h" },
      ledger: [authored("recipe", PATH, "h")],
    }));
    expect(v.ok).toBe(false);
    expect(v.summary).toContain("baseline-missing");
    expect(v.violations[0]!.reason).toContain("slowcook provenance init");
  });

  it("no baseline but nothing owned changed = pass, with a loud note", () => {
    const v = verifyProtection(base({ baseline: null, changedPaths: ["src/x.ts"] }));
    expect(v.ok).toBe(true);
    expect(v.summary).toContain("provenance init");
  });

  it("a derived trigger with evidence authorises the owning agent (worker model)", () => {
    const v = verifyProtection(base({
      changedPaths: [PATH],
      headHashes: { [PATH]: "h" },
      ledger: [authored("recipe", PATH, "h", {
        issue: undefined, issue_labels: undefined,
        derived: { reason: "(derived) tests-pr-review", evidence: "PR #226 review by taste" },
      })],
    }));
    expect(v.ok).toBe(true);
    expect(v.sanctioned[0]!.via).toContain("(derived) tests-pr-review");
  });

  it("a derived trigger without evidence is no record", () => {
    const v = verifyProtection(base({
      changedPaths: [PATH],
      headHashes: { [PATH]: "h" },
      ledger: [authored("recipe", PATH, "h", {
        issue: undefined, issue_labels: undefined,
        derived: { reason: "(derived) tests-pr-review", evidence: "  " },
      })],
    }));
    expect(v.ok).toBe(false);
  });

  it("allowed_derived: [] means labelled issues only", () => {
    const strict: OwnershipConfig = {
      rules: [{ artifact: "story tests", manifest_tests: true, agent: "recipe", issue_label: "agent:recipe", allowed_derived: [] }],
    };
    const v = verifyProtection(base({
      config: strict,
      changedPaths: [PATH],
      headHashes: { [PATH]: "h" },
      ledger: [authored("recipe", PATH, "h", {
        issue: undefined, issue_labels: undefined,
        derived: { reason: "(derived) tests-pr-review", evidence: "PR #226" },
      })],
    }));
    expect(v.ok).toBe(false);
    expect(v.violations[0]!.reason).toContain("not accepted");
  });
});
