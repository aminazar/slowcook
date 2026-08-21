import { describe, it, expect } from "vitest";
import { buildRollupItems, renderRollupBody, parseRollupKeys } from "./pm-rollup.js";
import type { AgentPrFact, IssueFact } from "./plan.js";

const issue = (n: number, labels: string[]): IssueFact =>
  ({ number: n, title: `issue ${n}`, labels, body: "" }) as unknown as IssueFact;
const pr = (n: number, rounds: number): AgentPrFact =>
  ({
    prNumber: n,
    headBranch: `slowcook/tests/story-0${n}`,
    title: `pr ${n}`,
    submittedReviewCount: rounds,
    lastCommitAt: "",
    lastAnyReviewAt: "",
    lastHumanReviewAt: null,
  }) as unknown as AgentPrFact;

describe("pm-rollup (D6)", () => {
  it("collects awaiting-pm, failed, and round-capped states with stable keys", () => {
    const items = buildRollupItems({
      awaitingPm: [{ number: 230, title: "clarify scope" }],
      issues: [issue(215, ["agent:failed"]), issue(216, ["agent:reciped"])],
      prs: [pr(226, 4), pr(227, 1)],
    });
    expect(items.map((i) => i.key)).toEqual(["awaiting-pm:230", "failed:215", "round-cap:226"]);
  });

  it("body round-trips keys; only NEW items would buzz", () => {
    const items = buildRollupItems({
      awaitingPm: [{ number: 230, title: "t" }],
      issues: [],
      prs: [pr(226, 4)],
    });
    const body = renderRollupBody(items);
    const keys = parseRollupKeys(body);
    expect(keys).toEqual(new Set(["awaiting-pm:230", "round-cap:226"]));
    const fresh = buildRollupItems({
      awaitingPm: [{ number: 230, title: "t" }, { number: 231, title: "new" }],
      issues: [],
      prs: [pr(226, 4)],
    }).filter((i) => !keys.has(i.key));
    expect(fresh.map((i) => i.key)).toEqual(["awaiting-pm:231"]);
  });

  it("empty list renders the all-clear body", () => {
    expect(renderRollupBody([])).toContain("Nothing is waiting on the PM");
  });
});
