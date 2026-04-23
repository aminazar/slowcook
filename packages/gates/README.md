# @slowcook-ai/gates

Gate 1 — deterministic mechanical UI checks for slowcook tier-2 acceptance tests. Wraps Playwright's `Page` API with checks for WCAG AA contrast, mobile tap-target size, horizontal overflow.

Part of slowcook 0.10. Gate 2 (AI vision) and Gate 3 (HITL via PR comments) land in later 0.10 point releases.

## Install

```bash
npm install --save-dev @slowcook-ai/gates @playwright/test
```

## Usage

```ts
import { test, expect } from "@playwright/test";
import { runGate1, checkContrast, checkTapTargets, checkNoOverflow } from "@slowcook-ai/gates";

test("Gate 1: mechanical UI checks pass on mobile", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/u/alice");
  const violations = await runGate1(page);
  expect(violations).toEqual([]);
});
```

Or call checks individually:

```ts
expect(await checkContrast(page)).toEqual([]);
expect(await checkTapTargets(page, { minSize: 44 })).toEqual([]);
expect(await checkNoOverflow(page)).toEqual([]);
```

## Exports

- **`runGate1(page)`** — run all checks in parallel; returns flat violation list.
- **`checkContrast(page)`** — WCAG 2.1 AA contrast check on visible text. Inline algorithm; no axe dependency.
- **`checkTapTargets(page, { minSize? })`** — interactive elements below 44×44 CSS px (default). Matches `button`, `a[href]`, `input`, `select`, `[role="button"]`, `[onclick]`.
- **`checkNoOverflow(page)`** — reports offenders when `document.scrollWidth > window.innerWidth`.

Each check returns `GateViolation[]`. Empty = clean.

## License

MIT.
