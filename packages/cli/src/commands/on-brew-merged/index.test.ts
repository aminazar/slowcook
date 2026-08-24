import { describe, it, expect } from "vitest";
import { stageLabelsToRemove } from "./index.js";

describe("stageLabelsToRemove (2026-08-24 — the board stops lying on human merges)", () => {
  it("removes agent stage labels and pipeline-state labels, keeps everything else", () => {
    expect(
      stageLabelsToRemove([
        { name: "agent:reciped" },
        { name: "spec-ready" },
        { name: "needs-refinement" },
        { name: "R2: Identity" },
        "bug",
        { name: "shipped" },
      ])
    ).toEqual(["agent:reciped", "spec-ready", "needs-refinement"]);
  });

  it("handles string labels and missing names", () => {
    expect(stageLabelsToRemove(["agent:brew", {}, "enhancement"])).toEqual(["agent:brew"]);
  });
});
