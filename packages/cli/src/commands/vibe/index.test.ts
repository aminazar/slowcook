import { describe, it, expect } from "vitest";

/**
 * 0.16.0-α.4 — eligibility gate now keys on `ui_behavior` block.
 * Re-implements the helper here so we can unit-test without exporting
 * it from index.ts (keeps the public surface narrow — only `vibe` is
 * exported).
 */
function hasUiSurface(specYaml: string): boolean {
  const uiIdx = specYaml.search(/^ui_behavior\s*:\s*$/m);
  if (uiIdx < 0) {
    if (/^ui_behavior\s*:\s*\{[\s\S]*?[a-z]/m.test(specYaml)) return true;
    return false;
  }
  const tail = specYaml.slice(uiIdx).split("\n").slice(1);
  for (const line of tail) {
    if (line.trim() === "") continue;
    if (/^[a-z_]/.test(line)) break;
    if (/^\s+[a-z_][a-z0-9_]*\s*:/.test(line)) return true;
  }
  return false;
}

describe("vibe — eligibility gate (hasUiSurface)", () => {
  it("returns true for a spec with non-empty ui_behavior block (block-style)", () => {
    const spec = `story_id: "017"
ui_behavior:
  desktop_light: "On /u/:handle, render a strip above the reactions list."
  mobile_light: "1.2-card peek on mobile."
acceptance_scenarios:
  - "When..."
`;
    expect(hasUiSurface(spec)).toBe(true);
  });

  it("returns true for an inline-mapping ui_behavior", () => {
    const spec = `ui_behavior: { desktop: "render here", mobile: "peek" }
`;
    expect(hasUiSurface(spec)).toBe(true);
  });

  it("returns true with only one viewport entry", () => {
    const spec = `ui_behavior:
  desktop_light: "render"
`;
    expect(hasUiSurface(spec)).toBe(true);
  });

  it("returns false when ui_behavior block is absent", () => {
    const spec = `story_id: "099"
title: backend cron
invariants:
  - runs nightly
`;
    expect(hasUiSurface(spec)).toBe(false);
  });

  it("returns false when ui_behavior block is present but empty (next top-level key follows immediately)", () => {
    const spec = `ui_behavior:
acceptance_scenarios:
  - "..."
`;
    expect(hasUiSurface(spec)).toBe(false);
  });

  it("returns false when ui_behavior block has only blank lines", () => {
    const spec = `ui_behavior:


acceptance_scenarios:
  - "..."
`;
    expect(hasUiSurface(spec)).toBe(false);
  });

  it("returns false when 'ui_behavior' appears only in prose (acceptance_scenarios)", () => {
    const spec = `invariants:
  - "the ui_behavior section is unimportant here"
acceptance_scenarios:
  - "When checking ui_behavior: ..."
`;
    expect(hasUiSurface(spec)).toBe(false);
  });

  it("returns true for a real story-017-shaped spec", () => {
    const spec = `story_id: "017"
title: Pinned rewos strip
status: active
ui_behavior:
  desktop_light: "render strip with 3 cards visible"
  mobile_light: "1.2-card peek; cards stack inside"
  mobile_dark: "dark variant of tints"
acceptance_scenarios:
  - "..."
`;
    expect(hasUiSurface(spec)).toBe(true);
  });
});
