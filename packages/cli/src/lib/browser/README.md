# Browser-driver seam — Playwright default, rustwright option

One interface (`BrowserDriver`), two engines. **Playwright is the default and the
failover; rustwright is an option** selected per-workload only where its
capabilities fit. Nothing is removed — Playwright stays the source of truth.

## Why

[rustwright](https://github.com/Skyvern-AI/rustwright) is a native Rust CDP engine
with a Playwright-shaped Node binding. Its vendor headline (2.55× faster, 70% less
memory) is measured against Playwright-**Python** and comes from eliminating the
Node driver subprocess Python needs — an advantage that **does not exist in Node**,
where Playwright already runs in-process. So we benchmarked it on slowcook's *own*
workloads before adopting anything.

## Benchmark (honest methodology)

`slowcook bench-browser [eye|qa|both]` forks a **fresh process per engine** (peak
RSS is order-dependent within a process — measuring both in one process gives a
false reading) and lazy-loads only the engine under test (a static import of both
loads Playwright's heavy client into the rustwright process and hides the
footprint). Point both at one browser via `PW_EXECUTABLE_PATH` +
`RUSTWRIGHT_CHROMIUM` for apples-to-apples.

Result on this workload (8 sessions each, same system Chrome, macOS arm64):

| workload | Δ rustwright vs playwright |
|----------|----------------------------|
| eye capture (goto + fullPage screenshot) | **−24% time · −50% RSS** |
| QA replay (goto/fill/click/assert/screenshot) | **−20% time · −55% RSS · 100% oracle agreement** |

So on Node the win is real but **modest on speed (~20%) and large on memory
(~50%)** — not the vendor's Python numbers. Memory is the decisive lever for a
QA-replay fleet (parallel sessions per box). rustwright produced the **identical
pass/fail** to the Playwright oracle (100% agreement) — the gate for using it.

## Capability fit (why the defaults are what they are)

rustwright's Node `Page` = `goto`/`click`/`fill`/`title`/`textContent`/`evaluate`/
`screenshot`. `newPage()` takes **no options**: no contexts, no
colorScheme/viewport/DPI emulation, no keyboard/hover/press, no locators/route/
tracing.

| path | default | why |
|------|---------|-----|
| **QA replay** (`replayPlanAuto`) | **rustwright** (PW failover) | needs only basic actions — fits; gets the memory win where it's decisive; 100% oracle agreement |
| **eye matrix** | **Playwright** | needs per-context colorScheme + retina DPI emulation rustwright lacks — forcing it = extra effort + lost fidelity; revisit when rustwright ships contexts |
| replays needing hover/keypress/drag | Playwright (failover) | rustwright has click+fill only |

`selectDriver({ need, prefer })` picks rustwright only when preferred **and** its
caps satisfy the need **and** it's installed — else Playwright, with a reason. It
never throws for a missing rustwright (it's an `optionalDependency`). Override
anywhere with `SLOWCOOK_BROWSER=playwright|rustwright`.

## Files

- `driver.ts` — the interface + `satisfies(caps, need)`.
- `playwright-driver.ts` / `rustwright-driver.ts` — the two engines.
- `select.ts` — capability-based selection + failover.
- `qa-replay.ts` — `replayPlan` (a recorded QA session → automatic rerun) + `replayPlanAuto` (proven default).
- `bench.ts` + `bench-worker.ts` — the fork-per-engine benchmark.
