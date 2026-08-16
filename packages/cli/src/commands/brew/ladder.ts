/**
 * LADDER MODE (the "emit one test at a time" world, release-based v1).
 *
 * The manifest carries the WHOLE coherent suite — testgen designs it up
 * front — but brew reveals it to the agent one RUNG at a time, in the order
 * the manifest declares (`release_order`, most-constraining-first). Rung k
 * must be fully green before rung k+1 exists as far as the agent knows: the
 * baseline "9 failed at once" wall can never form, because only the first
 * rung is ever scored while red.
 *
 * Tests without a release_order share rung 0 (today's behavior exactly —
 * a manifest with no orders is a single rung containing everything, so
 * ladder mode without orders degrades to plain brew; zero migration).
 *
 * Pure module: window arithmetic only, no IO, fully unit-tested.
 */

export interface LadderTest {
  id: string;
  /** Rung number; lower releases first. Absent → rung 0. */
  release_order?: number;
}

export interface LadderWindow {
  /** Test ids the agent can see and be scored on right now. */
  released: Set<string>;
  /** The frontier rung — the lowest rung not yet fully green. */
  rung: number;
  /** Ids on the frontier rung (the current work). */
  frontier: string[];
  /** How many tests remain unreleased (invisible). */
  held: number;
  /** True when every rung is green — the ladder is climbed. */
  complete: boolean;
}

/**
 * Compute the released window: every rung UP TO AND INCLUDING the first rung
 * with a non-green test. Earlier (green) rungs stay released so regressions
 * on them are still caught — the ratchet's keep-the-greens contract survives
 * windowing.
 */
export function ladderWindow(tests: LadderTest[], greenIds: Set<string>): LadderWindow {
  const byRung = new Map<number, string[]>();
  for (const t of tests) {
    const r = t.release_order ?? 0;
    const arr = byRung.get(r);
    if (arr) arr.push(t.id);
    else byRung.set(r, [t.id]);
  }
  const rungs = [...byRung.keys()].sort((a, b) => a - b);

  const released = new Set<string>();
  let frontierRung = rungs.length > 0 ? rungs[rungs.length - 1]! : 0;
  let frontier: string[] = [];
  let complete = true;

  for (const r of rungs) {
    const ids = byRung.get(r)!;
    for (const id of ids) released.add(id);
    if (ids.some((id) => !greenIds.has(id))) {
      frontierRung = r;
      frontier = ids.filter((id) => !greenIds.has(id));
      complete = false;
      break;
    }
  }

  let held = 0;
  for (const t of tests) if (!released.has(t.id)) held++;

  return { released, rung: frontierRung, frontier, held, complete };
}

/** One log line describing the window, for the run log. */
export function describeWindow(w: LadderWindow, total: number): string {
  if (w.complete) return `LADDER complete — all ${total} tests released and green`;
  return `LADDER rung ${w.rung}: ${w.frontier.length} red on the frontier · ${w.released.size}/${total} released · ${w.held} held back`;
}
