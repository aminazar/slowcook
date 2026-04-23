import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findStaleFixtures } from "./staleness.js";

describe("findStaleFixtures", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "slowcook-staleness-"));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  function writeFixture(path: string, recordedAtIso: string): void {
    const abs = join(tmp, path);
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, JSON.stringify({ recorded_at: recordedAtIso }));
  }

  it("returns [] when no fixtures exist", () => {
    expect(findStaleFixtures({ fixturesRoot: tmp })).toEqual([]);
  });

  it("returns [] when all fixtures are fresh", () => {
    writeFixture("story-005/supabase/abc.json", "2026-04-20T00:00:00.000Z");
    const stale = findStaleFixtures({
      fixturesRoot: tmp,
      now: new Date("2026-04-24T00:00:00.000Z"),
      maxAgeDays: 14,
    });
    expect(stale).toEqual([]);
  });

  it("flags fixtures older than the threshold", () => {
    writeFixture("story-005/supabase/old.json", "2026-03-01T00:00:00.000Z");
    writeFixture("story-005/supabase/fresh.json", "2026-04-20T00:00:00.000Z");
    const stale = findStaleFixtures({
      fixturesRoot: tmp,
      now: new Date("2026-04-24T00:00:00.000Z"),
      maxAgeDays: 14,
    });
    expect(stale).toHaveLength(1);
    expect(stale[0]?.path).toMatch(/old\.json$/);
    expect(stale[0]?.ageDays).toBeGreaterThanOrEqual(14);
  });

  it("scopes to a specific story when storyId is set", () => {
    writeFixture("story-005/supabase/old.json", "2026-03-01T00:00:00.000Z");
    writeFixture("story-006/supabase/old.json", "2026-03-01T00:00:00.000Z");
    const stale = findStaleFixtures({
      fixturesRoot: tmp,
      storyId: "005",
      now: new Date("2026-04-24T00:00:00.000Z"),
    });
    expect(stale).toHaveLength(1);
    expect(stale[0]?.path).toMatch(/story-005/);
  });
});
