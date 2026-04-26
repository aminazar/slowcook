import { describe, it, expect } from "vitest";
import { parsePlateSummary } from "./agent.js";
import { parseVibeOutput } from "../vibe/emit.js";

/**
 * Plate's runtime path requires Anthropic vision-message support and
 * GitHub network access for fetching PR comments + screenshot
 * attachments. Unit tests cover parsing + summary extraction; live
 * runs (V13+) validate the LLM loop end-to-end on rewo.
 */

describe("plate — output parsing", () => {
  it("extracts <plate_summary> block", () => {
    const body = `<file path="src/page.tsx">amended</file>
<plate_summary>
- Applied: changed strip padding p-3 → p-4
- Declined: PM asked for a token that doesn't exist
</plate_summary>`;
    expect(parsePlateSummary(body)).toContain("Applied");
    expect(parsePlateSummary(body)).toContain("Declined");
  });

  it("returns null when no summary block present", () => {
    const body = `<file path="x.ts">just a file, no summary</file>`;
    expect(parsePlateSummary(body)).toBeNull();
  });

  it("uses the same vibe-emit parser for file + change-request blocks", () => {
    const body = `<file path="src/components/feed.tsx">
amended contents
</file>
<component_change_request component="RewoCard" path="src/components/rewo/rewo-card.tsx">
needs variant="pinned" prop
</component_change_request>
<plate_summary>
- Applied: amended feed component
- Surfaced: RewoCard variant request
</plate_summary>`;
    const out = parseVibeOutput(body);
    expect(out.files).toHaveLength(1);
    expect(out.files[0]!.path).toBe("src/components/feed.tsx");
    expect(out.changeRequests).toHaveLength(1);
    expect(out.changeRequests[0]!.component).toBe("RewoCard");
  });

  it("supports multi-file amendments (preserves order)", () => {
    const body = `<file path="a.tsx">A</file>
<file path="b.tsx">B</file>
<file path="c.tsx">C</file>
<plate_summary>three files changed</plate_summary>`;
    const out = parseVibeOutput(body);
    expect(out.files.map((f) => f.path)).toEqual(["a.tsx", "b.tsx", "c.tsx"]);
  });

  it("treats the summary block as last-block convention (parses regardless of position, but prefers tail)", () => {
    // Defensive: the system prompt says summary is LAST, but parser
    // shouldn't fail if model puts it elsewhere.
    const body = `<plate_summary>summary first</plate_summary>
<file path="a.tsx">A</file>`;
    expect(parsePlateSummary(body)).toBe("summary first");
    const out = parseVibeOutput(body);
    expect(out.files).toHaveLength(1);
  });
});
