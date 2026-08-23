import { describe, it, expect } from "vitest";
import { finalGateVerdict } from "./gate-verdict.js";

const ids = (...xs: string[]) => new Set(xs);

describe("finalGateVerdict", () => {
  it("fails CLOSED when any suite runner is broken — the story-016 waiver is dead", () => {
    const v = finalGateVerdict(
      {
        ran: false,
        error: "[acceptance] exit 1, no parsable JSON",
        suiteErrors: [{ suite: "acceptance", error: "exit 1, no parsable JSON" }],
        tests: [
          // db suite DID run and is screaming — the old gate threw this away
          { id: "db/story-016-pins.test.sql", status: "failed" },
        ],
      },
      ids("db/story-016-pins.test.sql"),
      ids()
    );
    expect(v).toMatchObject({ kind: "runner_broken", brokenSuites: ["acceptance"] });
  });

  it("names every broken suite in the verdict", () => {
    const v = finalGateVerdict(
      {
        ran: false,
        suiteErrors: [
          { suite: "acceptance", error: "x" },
          { suite: "db", error: "y" },
        ],
        tests: [],
      },
      ids(),
      ids()
    );
    expect(v.kind).toBe("runner_broken");
    if (v.kind === "runner_broken") {
      expect(v.brokenSuites).toEqual(["acceptance", "db"]);
      expect(v.detail).toContain("[acceptance] x");
      expect(v.detail).toContain("[db] y");
    }
  });

  it("story-scoped red at the gate is its own verdict, before regression logic", () => {
    const v = finalGateVerdict(
      {
        ran: true,
        tests: [
          { id: "db/story-016-pins.test.sql", status: "failed", failure_message: "pins table missing" },
          { id: "other/story-001.test.ts", status: "failed" },
        ],
      },
      ids("db/story-016-pins.test.sql"),
      ids()
    );
    expect(v).toMatchObject({
      kind: "story_red",
      storyRed: [{ id: "db/story-016-pins.test.sql", failure_message: "pins table missing" }],
    });
  });

  it("green-at-baseline outside-story red is a true regression; baseline-red is not", () => {
    const v = finalGateVerdict(
      {
        ran: true,
        tests: [
          { id: "a", status: "passed" },
          { id: "was-green", status: "failed" },
          { id: "always-red", status: "failed" },
        ],
      },
      ids("a"),
      ids("was-green")
    );
    expect(v).toMatchObject({ kind: "regression", preExistingRed: 1 });
    if (v.kind === "regression") expect(v.breaks.map((b) => b.id)).toEqual(["was-green"]);
  });

  it("passes with counts when nothing is broken, story is green, no true regressions", () => {
    const v = finalGateVerdict(
      {
        ran: true,
        tests: [
          { id: "a", status: "passed" },
          { id: "always-red", status: "failed" },
        ],
      },
      ids("a"),
      ids()
    );
    expect(v).toEqual({ kind: "pass", fullGreen: 1, preExistingRed: 1 });
  });
});
