// backprop: the amendment lands on the owning story; owningStory resolves via
// path convention and testgen manifests.
import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { appendAmendment, owningStory } from "./amend.js";

function repo(): string {
  const r = mkdtempSync(join(tmpdir(), "amend-"));
  mkdirSync(join(r, "specs"), { recursive: true });
  mkdirSync(join(r, ".brewing/manifests"), { recursive: true });
  writeFileSync(join(r, "specs/story-042.yaml"), "title: Sorting\nstatus: active\n");
  writeFileSync(join(r, ".brewing/manifests/story-042.json"), JSON.stringify({ tests: ["tests/sorting/order.test.ts"] }));
  return r;
}

describe("appendAmendment", () => {
  it("appends an amendments entry to the story yaml (creates the list)", () => {
    const r = repo();
    appendAmendment(r, "042", { at: "2026-07-11T00:00:00Z", reason: "sort-order contract changed", pr: "#88" });
    const y = readFileSync(join(r, "specs/story-042.yaml"), "utf8");
    expect(y).toContain("amendments:");
    expect(y).toContain("sort-order contract changed");
    // appends, not replaces
    appendAmendment(r, "042", { at: "2026-07-12T00:00:00Z", reason: "second amendment" });
    const y2 = readFileSync(join(r, "specs/story-042.yaml"), "utf8");
    expect(y2).toContain("second amendment");
    expect(y2).toContain("sort-order contract changed");
  });
});

describe("owningStory", () => {
  it("resolves by story-id in the path", () => {
    expect(owningStory("/nowhere", "tests/integration/story-007-shape.test.tsx")).toBe("007");
  });
  it("resolves via the testgen manifest when the path has no id", () => {
    const r = repo();
    expect(owningStory(r, "tests/sorting/order.test.ts")).toBe("042");
  });
  it("null when unowned", () => {
    const r = repo();
    expect(owningStory(r, "tests/misc/other.test.ts")).toBeNull();
  });
});
