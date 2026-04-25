import { describe, it, expect } from "vitest";
import {
  validateBugProfile,
  BUG_PROFILE_SCHEMA_VERSION,
  type BugProfile,
} from "./schema.js";

function makeValid(): BugProfile {
  return {
    schema_version: BUG_PROFILE_SCHEMA_VERSION,
    bug_id: "B-1",
    title: "/feed reactor names not hyperlinked despite story-013 brew",
    source_issue: "#135",
    status: "investigated",
    investigated_by: "slowcook-investigate@0.13.0-alpha.2a",
    created_at: "2026-04-25T22:30:00.000Z",
    symptom: ["Story-013 added Link rendering, but every name is plain text on /feed."],
    expected: ["Each reactor display_name should be a <Link> to /u/<handle>."],
    reproduction: ["Load /feed as authenticated user with at least one connection-reaction."],
    failure_locus: {
      file: "src/app/api/feed/connections/route.ts",
      line: 38,
      function: "GET",
      diagnosis:
        "Selects (id, display_name) from profiles but FeedPage reads member.handle. Always undefined → no link rendered.",
    },
    regression_assertion: [
      "Given a connection-reaction row, when /feed renders, then the reactor name is wrapped in <a href=/u/<handle>>.",
    ],
    fix_scope: [
      "src/app/api/feed/connections/route.ts",
      "src/components/rewo/feed-page.tsx",
    ],
  };
}

describe("validateBugProfile", () => {
  it("accepts a valid profile", () => {
    const r = validateBugProfile(makeValid());
    expect(r.ok).toBe(true);
  });

  it("rejects non-objects at root", () => {
    expect(validateBugProfile(null).ok).toBe(false);
    expect(validateBugProfile("string").ok).toBe(false);
    expect(validateBugProfile([]).ok).toBe(false);
  });

  it("requires schema_version === 1", () => {
    const p = makeValid() as unknown as Record<string, unknown>;
    p["schema_version"] = 2;
    const r = validateBugProfile(p);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some((e) => /schema_version/.test(e))).toBe(true);
  });

  it("requires bug_id matching B-<n>", () => {
    const p = makeValid() as unknown as Record<string, unknown>;
    p["bug_id"] = "story-013";
    const r = validateBugProfile(p);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some((e) => /bug_id/.test(e))).toBe(true);
  });

  it("requires source_issue matching #<NNN>", () => {
    const p = makeValid() as unknown as Record<string, unknown>;
    p["source_issue"] = "issue-135";
    const r = validateBugProfile(p);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some((e) => /source_issue/.test(e))).toBe(true);
  });

  it("requires symptom / expected / reproduction / regression_assertion / fix_scope as string arrays", () => {
    const p = makeValid() as unknown as Record<string, unknown>;
    p["symptom"] = "single string";
    const r = validateBugProfile(p);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some((e) => /symptom/.test(e))).toBe(true);
  });

  it("requires failure_locus to be an object with file + diagnosis", () => {
    const p = makeValid() as unknown as Record<string, unknown>;
    p["failure_locus"] = { file: "" };
    const r = validateBugProfile(p);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors.some((e) => /failure_locus\.file/.test(e))).toBe(true);
      expect(r.errors.some((e) => /failure_locus\.diagnosis/.test(e))).toBe(true);
    }
  });

  it("rejects failure_locus.line when not a number", () => {
    const p = makeValid();
    (p.failure_locus as unknown as Record<string, unknown>)["line"] = "42";
    const r = validateBugProfile(p);
    expect(r.ok).toBe(false);
  });

  it("accepts profile with optional fields omitted (line, function, related_specs)", () => {
    const p = makeValid();
    p.failure_locus.line = undefined;
    p.failure_locus.function = undefined;
    delete p.related_specs;
    const r = validateBugProfile(p);
    expect(r.ok).toBe(true);
  });
});
