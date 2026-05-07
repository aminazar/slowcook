import { describe, it, expect } from "vitest";
import {
  detectStubMarker,
  daysBetween,
  classifyStubAge,
  buildStaleStubComment,
  type StubFile,
} from "./stale-stubs.js";

describe("detectStubMarker (#84)", () => {
  it("detects bare @slowcook-stub", () => {
    const r = detectStubMarker("// @slowcook-stub\nthrow new Error('x');");
    expect(r.isStub).toBe(true);
    expect(r.storyId).toBeNull();
  });

  it("extracts story id from explicit form", () => {
    const r = detectStubMarker("// @slowcook-stub story-018\nthrow new Error('x');");
    expect(r.isStub).toBe(true);
    expect(r.storyId).toBe("018");
  });

  it("works with block-comment form", () => {
    const r = detectStubMarker("/* @slowcook-stub story-016\n * placeholder\n */\n");
    expect(r.isStub).toBe(true);
    expect(r.storyId).toBe("016");
  });

  it("returns isStub=false for normal code", () => {
    const r = detectStubMarker("import { useState } from 'react';\nexport const X = 1;");
    expect(r.isStub).toBe(false);
    expect(r.storyId).toBeNull();
  });

  it("only checks first 500 chars (header-only)", () => {
    const padding = "x".repeat(550);
    const r = detectStubMarker(`${padding}\n// @slowcook-stub story-016`);
    expect(r.isStub).toBe(false);
  });

  it("multi-digit story id (e.g., 100+)", () => {
    const r = detectStubMarker("// @slowcook-stub story-142");
    expect(r.storyId).toBe("142");
  });
});

describe("daysBetween", () => {
  it("computes whole days", () => {
    expect(daysBetween("2026-05-01T00:00:00Z", "2026-05-08T00:00:00Z")).toBe(7);
  });

  it("rounds to 1 decimal", () => {
    // 36 hours = 1.5 days
    expect(daysBetween("2026-05-01T00:00:00Z", "2026-05-02T12:00:00Z")).toBe(1.5);
  });

  it("returns 0 for same timestamp", () => {
    expect(daysBetween("2026-05-01T00:00:00Z", "2026-05-01T00:00:00Z")).toBe(0);
  });

  it("returns 0 (clamps) when later is before earlier", () => {
    expect(daysBetween("2026-05-08T00:00:00Z", "2026-05-01T00:00:00Z")).toBe(0);
  });

  it("returns 0 for invalid input", () => {
    expect(daysBetween("not-a-date", "2026-05-08T00:00:00Z")).toBe(0);
    expect(daysBetween("2026-05-01T00:00:00Z", "garbage")).toBe(0);
  });
});

describe("classifyStubAge", () => {
  it("returns 'unknown' when ageDays is null", () => {
    expect(classifyStubAge(null, 14)).toBe("unknown");
  });

  it("returns 'fresh' below the grace period", () => {
    expect(classifyStubAge(7, 14)).toBe("fresh");
    expect(classifyStubAge(13.9, 14)).toBe("fresh");
  });

  it("returns 'stale' at or above the grace period", () => {
    expect(classifyStubAge(14, 14)).toBe("stale");
    expect(classifyStubAge(30, 14)).toBe("stale");
  });

  it("returns 'fresh' for 0 days (just-added)", () => {
    expect(classifyStubAge(0, 14)).toBe("fresh");
  });
});

describe("buildStaleStubComment", () => {
  const stub: StubFile = {
    path: "src/app/api/pins/route.ts",
    storyId: "016",
    firstAddedAt: "2026-04-20T12:00:00Z",
    ageDays: 17.5,
    classification: "stale",
  };

  it("includes the path + age + grace period", () => {
    const body = buildStaleStubComment(stub, 14);
    expect(body).toContain("src/app/api/pins/route.ts");
    expect(body).toContain("17.5");
    expect(body).toContain("after 14 days");
  });

  it("includes the three PM-action options", () => {
    const body = buildStaleStubComment(stub, 14);
    expect(body).toContain("Re-dispatch brew");
    expect(body).toContain("Hand-write the implementation");
    expect(body).toContain("Withdraw the story");
  });

  it("handles unknown firstAddedAt gracefully", () => {
    const unknown: StubFile = { ...stub, firstAddedAt: null, ageDays: null };
    const body = buildStaleStubComment(unknown, 14);
    expect(body).toContain("src/app/api/pins/route.ts");
    expect(body).not.toMatch(/\(added/); // doesn't try to format the missing date
  });

  it("includes the auto-rerun footer note", () => {
    const body = buildStaleStubComment(stub, 14);
    expect(body).toContain("slowcook recon --stub-scan");
  });
});
