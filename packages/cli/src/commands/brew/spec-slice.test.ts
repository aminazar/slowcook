import { describe, it, expect } from "vitest";
import {
  extractIdentifiersFromTargetTest,
  sliceSpecForTarget,
  renderSpecSlice,
} from "./spec-slice.js";
import type { Spec } from "@slowcook-ai/core";

const baseSpec: Spec = {
  story_id: "007",
  title: "bookmarks",
  status: "active",
  created_at: "2026-04-25T00:00:00Z",
  supersedes: [],
  superseded_by: null,
  actors: [],
  preconditions: [],
  invariants: [],
  acceptance_scenarios: [],
  non_goals: ["always non-goal"],
};

describe("extractIdentifiersFromTargetTest", () => {
  it("pulls path segments", () => {
    const ids = extractIdentifiersFromTargetTest(
      "tests/integration/story-007.test.ts > POST /api/bookmarks > saves a row"
    );
    expect(ids.has("/api/bookmarks")).toBe(true);
  });

  it("pulls camelCase + PascalCase identifiers", () => {
    const ids = extractIdentifiersFromTargetTest(
      "tests/integration/story-007-ui.test.tsx > BookmarksPage > clicking Save"
    );
    expect(ids.has("bookmarkspage")).toBe(true);
    expect(ids.has("save")).toBe(true);
  });

  it("strips common stop-words", () => {
    const ids = extractIdentifiersFromTargetTest(
      "tests/x.test.ts > the test should call when given a value"
    );
    expect(ids.has("the")).toBe(false);
    expect(ids.has("when")).toBe(false);
    expect(ids.has("given")).toBe(false);
    expect(ids.has("should")).toBe(false);
  });

  it("captures backticked identifiers explicitly", () => {
    const ids = extractIdentifiersFromTargetTest(
      "tests/x.test.ts > calls `getProfileByHandle` with the slug"
    );
    expect(ids.has("getprofilebyhandle")).toBe(true);
  });

  it("works on a file-only id (no separator)", () => {
    const ids = extractIdentifiersFromTargetTest("BookmarksPage");
    expect(ids.size).toBeGreaterThan(0);
  });
});

describe("sliceSpecForTarget", () => {
  it("keeps only invariants matching the target's identifiers", () => {
    const spec: Spec = {
      ...baseSpec,
      invariants: [
        "POST /api/bookmarks creates a row with member_id = caller",
        "GET /api/feed returns reverse-chronological items",
        "BookmarksPage renders a list when items > 0",
      ],
      acceptance_scenarios: [
        "Given a member, When they POST /api/bookmarks, Then a row is created",
      ],
    };
    const slice = sliceSpecForTarget(
      spec,
      "tests/integration/story-007.test.ts > POST /api/bookmarks > saves"
    );
    expect(slice.invariants).toContain(
      "POST /api/bookmarks creates a row with member_id = caller"
    );
    expect(slice.invariants).not.toContain(
      "GET /api/feed returns reverse-chronological items"
    );
    expect(slice.fellBack).toBe(false);
  });

  it("falls back to full spec when too few invariants match", () => {
    const spec: Spec = {
      ...baseSpec,
      invariants: [
        "Bar handles X",
        "Baz handles Y",
        "Quux handles Z",
        "Plugh handles W",
      ],
    };
    const slice = sliceSpecForTarget(
      spec,
      "tests/integration/x.test.ts > completely unrelated > foobar"
    );
    expect(slice.fellBack).toBe(true);
    expect(slice.invariants).toEqual(spec.invariants);
  });

  it("always keeps non_goals", () => {
    const spec: Spec = {
      ...baseSpec,
      invariants: ["POST /api/bookmarks creates a row"],
      non_goals: ["never expose internal ids", "no rate limiting in v1"],
    };
    const slice = sliceSpecForTarget(
      spec,
      "tests/x.test.ts > POST /api/bookmarks > saves"
    );
    expect(slice.non_goals).toEqual(spec.non_goals);
  });

  it("reports kept/total ratios for telemetry", () => {
    const spec: Spec = {
      ...baseSpec,
      invariants: [
        "POST /api/bookmarks creates a row",
        "GET /api/feed orders newest-first",
        "DELETE /api/bookmarks deletes a row",
      ],
      acceptance_scenarios: [
        "Given a member, When they POST /api/bookmarks, Then a row is created",
        "Given items exist, When GET /api/feed, Then ordered newest-first",
      ],
    };
    const slice = sliceSpecForTarget(
      spec,
      "tests/integration/story-007.test.ts > POST /api/bookmarks > saves"
    );
    expect(slice.ratio.invariants.total).toBe(3);
    expect(slice.ratio.invariants.kept).toBeGreaterThan(0);
    expect(slice.ratio.invariants.kept).toBeLessThan(3);
    expect(slice.ratio.scenarios.total).toBe(2);
  });

  it("respects minKept option for the fallback threshold", () => {
    const spec: Spec = {
      ...baseSpec,
      invariants: [
        "POST /api/bookmarks creates a row",
        "POST /api/bookmarks rejects unauth",
        "GET /api/feed orders newest-first",
        "DELETE /api/bookmarks deletes a row",
      ],
    };
    const slice = sliceSpecForTarget(
      spec,
      "tests/x.test.ts > POST /api/bookmarks > saves",
      { minKept: 5 }
    );
    // 2 matches < minKept=5, so falls back to full
    expect(slice.fellBack).toBe(true);
    expect(slice.invariants.length).toBe(4);
  });
});

describe("renderSpecSlice", () => {
  it("emits YAML-shaped prose with story_id + title preserved", () => {
    const spec: Spec = {
      ...baseSpec,
      story_id: "007",
      title: "Bookmarks",
      invariants: ["POST /api/bookmarks creates a row"],
      acceptance_scenarios: ["Given a member, When POST, Then row created"],
    };
    const slice = sliceSpecForTarget(
      spec,
      "tests/x.test.ts > POST /api/bookmarks > saves"
    );
    const yaml = renderSpecSlice(slice, spec);
    expect(yaml).toContain('story_id: "007"');
    expect(yaml).toContain("title:");
    expect(yaml).toContain("invariants:");
    expect(yaml).toContain("/api/bookmarks");
  });

  it("omits empty arrays", () => {
    const spec: Spec = {
      ...baseSpec,
      invariants: ["POST /api/x creates"],
      acceptance_scenarios: [],
      non_goals: [],
    };
    const slice = sliceSpecForTarget(spec, "POST /api/x");
    const yaml = renderSpecSlice(slice, spec);
    expect(yaml).not.toContain("acceptance_scenarios:");
    expect(yaml).not.toContain("non_goals:");
  });
});
