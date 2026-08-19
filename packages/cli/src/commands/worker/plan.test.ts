import { describe, it, expect } from "vitest";
import {
  deriveJobs,
  evaluatePreconditions,
  summarizeWorkload,
  renderWorkloadLine,
  type IssueFact,
  type StoryArtifactFacts,
} from "./plan.js";

function issue(over: Partial<IssueFact> & { number: number }): IssueFact {
  return {
    title: `Issue ${over.number}`,
    body: "a body",
    labels: [],
    createdAt: "2026-08-01T00:00:00Z",
    ...over,
  };
}

const noFacts = (): StoryArtifactFacts => ({});

describe("deriveJobs", () => {
  it("maps each trigger label to its agent and cmd", () => {
    const jobs = deriveJobs(
      [issue({ number: 7, labels: ["agent:refine"] })],
      noFacts
    );
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.agent).toBe("refine");
    expect(jobs[0]!.cmd).toEqual(["slowcook", "refine", "--issue", "7"]);
  });

  it("ignores issues with no trigger label", () => {
    const jobs = deriveJobs([issue({ number: 1, labels: ["bug"] })], noFacts);
    expect(jobs).toHaveLength(0);
  });

  it("agent:failed is terminal — no jobs even with a trigger present", () => {
    const jobs = deriveJobs(
      [issue({ number: 2, labels: ["agent:refine", "agent:failed"] })],
      noFacts
    );
    expect(jobs).toHaveLength(0);
  });

  it("an issue with two trigger labels yields two jobs", () => {
    const jobs = deriveJobs(
      [issue({ number: 3, labels: ["agent:refine", "agent:brew"] })],
      () => ({ storyId: "003" })
    );
    expect(jobs.map((j) => j.agent).sort()).toEqual(["brew", "refine"]);
  });

  it("uses the resolved storyId in recipe/brew/eye cmds", () => {
    const jobs = deriveJobs(
      [issue({ number: 4, labels: ["agent:brew"] })],
      () => ({ storyId: "021", manifestExists: true, testsDiscoverable: true })
    );
    expect(jobs[0]!.cmd).toEqual(["slowcook", "brew", "--story", "021"]);
  });

  it("orders blocked jobs before runnable ones (unblock before advance)", () => {
    const jobs = deriveJobs(
      [
        issue({ number: 10, labels: ["agent:refine"], createdAt: "2026-08-01T00:00:00Z" }),
        issue({ number: 11, labels: ["agent:refine"], body: "", createdAt: "2026-08-02T00:00:00Z" }),
      ],
      noFacts
    );
    expect(jobs[0]!.issue).toBe(11); // blocked (empty body) surfaces first
    expect(jobs[0]!.runnable).toBe(false);
    expect(jobs[1]!.issue).toBe(10);
  });

  it("orders by priority label, then oldest first", () => {
    const jobs = deriveJobs(
      [
        issue({ number: 20, labels: ["agent:refine"], createdAt: "2026-08-01T00:00:00Z" }),
        issue({ number: 21, labels: ["agent:refine", "priority:1"], createdAt: "2026-08-05T00:00:00Z" }),
        issue({ number: 22, labels: ["agent:refine"], createdAt: "2026-07-01T00:00:00Z" }),
      ],
      noFacts
    );
    expect(jobs.map((j) => j.issue)).toEqual([21, 22, 20]);
  });
});

describe("evaluatePreconditions", () => {
  it("refine fails on an empty issue body, with no upstream (operator-owned)", () => {
    const checks = evaluatePreconditions("refine", issue({ number: 5, body: "  " }), {});
    expect(checks).toHaveLength(1);
    expect(checks[0]!.status).toBe("fail");
    expect(checks[0]!.upstream).toBeUndefined();
  });

  it("recipe with no story in the index names refine as the upstream", () => {
    const checks = evaluatePreconditions("recipe", issue({ number: 6 }), {});
    const specExists = checks.find((c) => c.name === "spec-exists")!;
    expect(specExists.status).toBe("fail");
    expect(specExists.upstream).toBe("refine");
    expect(specExists.detail).toContain("#6");
  });

  it("recipe passes when the spec parses and has invariants", () => {
    const checks = evaluatePreconditions("recipe", issue({ number: 6 }), {
      storyId: "006",
      specParses: true,
      invariantsNonEmpty: true,
    });
    expect(checks.every((c) => c.status === "pass")).toBe(true);
  });

  it("brew names recipe as upstream for a missing manifest", () => {
    const checks = evaluatePreconditions("brew", issue({ number: 8 }), {
      storyId: "008",
      manifestExists: false,
    });
    const m = checks.find((c) => c.name === "manifest-exists")!;
    expect(m.status).toBe("fail");
    expect(m.upstream).toBe("recipe");
  });

  it("ungathered facts are unknown, never pass", () => {
    const checks = evaluatePreconditions("brew", issue({ number: 9 }), { storyId: "009" });
    const m = checks.find((c) => c.name === "manifest-exists")!;
    expect(m.status).toBe("unknown");
    expect(m.detail).toContain("not gathered");
  });

  it("eye's build/deploy checks are unknown in W0 and say why", () => {
    const checks = evaluatePreconditions("eye", issue({ number: 12 }), { storyId: "012" });
    expect(checks.map((c) => c.status)).toEqual(["unknown", "unknown"]);
  });
});

describe("workload summary", () => {
  it("counts scanned issues, triggers, blocked, and failed-awaiting-human", () => {
    const issues = [
      issue({ number: 1, labels: ["agent:refine"] }),
      issue({ number: 2, labels: ["agent:refine"], body: "" }),
      issue({ number: 3, labels: ["agent:failed"] }),
    ];
    const jobs = deriveJobs(issues, noFacts);
    const s = summarizeWorkload(issues, jobs);
    expect(s.issuesScanned).toBe(3);
    expect(s.triggersFound).toBe(2);
    expect(s.failedAwaitingHuman).toEqual([3]);
    const line = renderWorkloadLine(s);
    expect(line).toContain("3 issues scanned");
    expect(line).toContain("2 triggers");
    expect(line).toContain("1 blocked");
    expect(line).toContain("1 agent:failed");
  });
});
