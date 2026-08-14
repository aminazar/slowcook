// dovizir §13 — the pre-loaded files block: a fresh-context brew iteration
// must start oriented, not re-read the repo through the round cap.
import { describe, it, expect } from "vitest";
import { turnPromptParts } from "./brew.js";

const base = {
  iteration: 2,
  max_iterations: 10,
  target_test_id: "story-001 > exports match the pinned .d.ts",
  target_test_file: "tests/integration/story-001.test.ts",
  spec_yaml: "story_id: '001'",
  currently_green: [],
  currently_red: ["story-001 > exports match the pinned .d.ts"],
  allowed_paths: [],
  budget_spent_usd: 0.5,
  budget_cap_usd: 10,
};

describe("turnPromptParts — preloaded_files_block (§13)", () => {
  it("renders the block in the DYNAMIC body, never the cached prefix", () => {
    const { cachedPrefix, dynamicBody } = turnPromptParts({
      ...base,
      preloaded_files_block: "### Pre-loaded files\n**`src/index.ts`:**\n```\nexport {}\n```",
    });
    // File contents track the working tree — cache-pinning them would serve
    // stale file bodies for the 5-minute TTL after every edit.
    expect(cachedPrefix).not.toContain("Pre-loaded files");
    expect(dynamicBody).toContain("Pre-loaded files");
    expect(dynamicBody).toContain("src/index.ts");
  });

  it("places the block before the test-state line, so the material precedes the plan", () => {
    const { dynamicBody } = turnPromptParts({
      ...base,
      preloaded_files_block: "### Pre-loaded files\nX",
    });
    expect(dynamicBody.indexOf("Pre-loaded files")).toBeLessThan(
      dynamicBody.indexOf("Test state going into this turn")
    );
  });

  it("omits the section entirely when absent or blank", () => {
    expect(turnPromptParts(base).dynamicBody).not.toContain("Pre-loaded files");
    expect(turnPromptParts({ ...base, preloaded_files_block: "  " }).dynamicBody).not.toContain("Pre-loaded files");
  });

  it("previous_attempts notes flow through verbatim — the revert lesson reaches the agent", () => {
    const { dynamicBody } = turnPromptParts({
      ...base,
      previous_attempts: [{
        iteration: 3,
        outcome: "reverted-regression",
        note: "your edit was REVERTED because it broke 4 green test(s): story-001 > deps are only @noble | story-001 > no ambient clock",
        files_touched: ["src/index.ts"],
      }],
    });
    expect(dynamicBody).toContain("REVERTED because it broke");
    expect(dynamicBody).toContain("no ambient clock"); // the NAME, not just a count
  });
});
