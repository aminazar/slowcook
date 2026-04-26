import { describe, it, expect } from "vitest";
import { parseVibeOutput } from "./emit.js";

/**
 * Vibe's runtime path requires an Anthropic API key + network access,
 * so the unit tests cover the parsing + emit logic exhaustively
 * (separate from emit.test.ts which exercises the file-write side).
 *
 * The agent loop itself (single-shot + format-compliance retry) is
 * validated in integration via the live runs on rewo (V12+).
 */

describe("vibe agent — output parsing edge cases", () => {
  it("ignores prose before/after the file blocks", () => {
    const out = parseVibeOutput(
      `Here is the mockup:

<file path="src/app/page.tsx">
export default function P() { return null; }
</file>

That's it!`
    );
    expect(out.files).toHaveLength(1);
    expect(out.files[0]!.path).toBe("src/app/page.tsx");
  });

  it("preserves interior whitespace + blank lines in file contents", () => {
    const out = parseVibeOutput(`<file path="x.ts">
import { a } from "./a";

export const b = 1;


export const c = 2;
</file>`);
    expect(out.files[0]!.contents).toContain('import { a } from "./a";');
    expect(out.files[0]!.contents).toMatch(/export const b[\s\S]+export const c/);
  });

  it("handles multiple change requests + multiple files in one emit", () => {
    const body = `<file path="src/a.tsx">A</file>
<file path="src/b.tsx">B</file>
<component_change_request component="X" path="src/x.tsx">need prop foo</component_change_request>
<component_change_request component="Y" path="src/y.tsx">need prop bar</component_change_request>`;
    const out = parseVibeOutput(body);
    expect(out.files).toHaveLength(2);
    expect(out.changeRequests).toHaveLength(2);
  });

  it("does not match malformed tags (missing path attribute)", () => {
    const body = `<file>no path</file>
<file path="ok.ts">ok</file>`;
    const out = parseVibeOutput(body);
    expect(out.files).toHaveLength(1);
    expect(out.files[0]!.path).toBe("ok.ts");
  });

  it("does not match unclosed tags", () => {
    const body = `<file path="open.ts">never closes`;
    const out = parseVibeOutput(body);
    expect(out.files).toHaveLength(0);
  });
});
