// Regression guard for React #310 — twice now a hook was added BELOW the
// shell's conditional early-returns. Mechanized: no hook call may appear
// after the first early return in ReviewShell.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

describe("ReviewShell hooks order", () => {
  it("no useEffect/useState/useMemo/useRef after the first conditional return", () => {
    const src = readFileSync(new URL("./review-shell.tsx", import.meta.url), "utf8");
    const body = src.slice(src.indexOf("export function ReviewShell"));
    const firstReturn = body.indexOf('if (!enabled || typeof document === "undefined") return null;');
    expect(firstReturn).toBeGreaterThan(0);
    const after = body.slice(firstReturn, body.indexOf("return createPortal"));
    for (const hook of ["useEffect(", "useState(", "useMemo(", "useRef("])
      expect(after.includes(hook), `${hook} after early return`).toBe(false);
  });
});
