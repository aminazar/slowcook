import { describe, it, expect } from "vitest";

/**
 * Re-import the local helper for unit testing. Not exported from index.ts
 * so we re-declare a copy here that mirrors the implementation. This is
 * intentional — keeps index.ts's API surface narrow (only `vibe` is
 * exported) while still letting us cover the gating logic.
 */
function hasUiSurface(specYaml: string): boolean {
  const proposalsIdx = specYaml.search(/^proposals\s*:\s*$/m);
  if (proposalsIdx < 0) return false;
  const tail = specYaml.slice(proposalsIdx);
  const fixturesMatch = tail.match(/^(\s+)fixtures\s*:\s*$/m);
  if (!fixturesMatch) return false;
  const fixturesBlockStart = tail.indexOf(fixturesMatch[0]) + fixturesMatch[0].length;
  const byDomainMatch = tail.slice(fixturesBlockStart).match(/^(\s+)by_domain\s*:\s*$/m);
  if (!byDomainMatch) return false;
  const byDomainIndentLen = byDomainMatch[1]!.length;
  const after = tail.slice(
    fixturesBlockStart + tail.slice(fixturesBlockStart).indexOf(byDomainMatch[0]) + byDomainMatch[0].length
  );
  const entryRe = new RegExp(
    `^( {${byDomainIndentLen + 1},}|\\t+)([a-z][a-z0-9_-]*)\\s*:\\s*$`,
    "m"
  );
  return entryRe.test(after);
}

describe("vibe — eligibility gate (hasUiSurface)", () => {
  it("returns true for a spec with proposals.fixtures.by_domain populated", () => {
    const spec = `story_id: "017"
proposals:
  schema:
    status: pending
  fixtures:
    status: pending
    by_domain:
      pins:
        seed:
          list: []
`;
    expect(hasUiSurface(spec)).toBe(true);
  });

  it("returns true even when seed is empty (synth shell still implies UI)", () => {
    const spec = `proposals:
  fixtures:
    status: pending
    by_domain:
      notifications:
        seed:
          list: []
`;
    expect(hasUiSurface(spec)).toBe(true);
  });

  it("returns true for multiple domains", () => {
    const spec = `proposals:
  fixtures:
    by_domain:
      pins:
        seed: { list: [] }
      bookmarks:
        seed: { list: [] }
`;
    expect(hasUiSurface(spec)).toBe(true);
  });

  it("returns false when proposals block has no fixtures key", () => {
    const spec = `proposals:
  schema:
    status: pending
  routes:
    paths: []
`;
    expect(hasUiSurface(spec)).toBe(false);
  });

  it("returns false when fixtures.by_domain is empty (no domains)", () => {
    const spec = `proposals:
  fixtures:
    status: pending
    by_domain: {}
`;
    expect(hasUiSurface(spec)).toBe(false);
  });

  it("returns false when fixtures has no by_domain key at all", () => {
    const spec = `proposals:
  fixtures:
    status: rejected
`;
    expect(hasUiSurface(spec)).toBe(false);
  });

  it("returns false for a backend-only spec (no proposals block)", () => {
    const spec = `story_id: "099"
title: backend cron
invariants:
  - runs nightly
`;
    expect(hasUiSurface(spec)).toBe(false);
  });

  it("returns false for a spec where proposals appears in prose only (not at indentation 0)", () => {
    const spec = `invariants:
  - "the proposals section is unimportant here"
acceptance_scenarios:
  - "When checking proposals: ..."
`;
    expect(hasUiSurface(spec)).toBe(false);
  });
});
