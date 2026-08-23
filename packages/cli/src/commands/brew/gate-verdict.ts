/**
 * Final-gate verdict (2026-08-23, the story-016 post-mortem).
 *
 * The old gate had one fatal mercy: `if (!finalRun.ran) { log; proceed }` —
 * ONE broken suite runner (acceptance playwright, exit 1) discarded the
 * verdicts of every suite that DID run, including the db suite whose
 * 14 red pgTAP tests were shouting that the migration didn't exist.
 *
 * New contract, fail closed:
 *   - any broken suite runner  → runner_broken (halt; a declared suite is
 *     a promise — fix the runner or remove the suite from stack.json)
 *   - any story-scoped red     → story_red (halt; belt-and-braces — the
 *     loop should have brewed these, so reaching the gate red means the
 *     contract wasn't satisfiable)
 *   - true transitive break    → regression (halt; green-at-baseline test
 *     outside the story went red)
 *   - otherwise                → pass
 */

export interface GateRunInput {
  ran: boolean;
  error?: string;
  suiteErrors?: { suite: string; error: string }[];
  tests: { id: string; status: string; failure_message?: string }[];
}

export type GateVerdict =
  | { kind: "pass"; fullGreen: number; preExistingRed: number }
  | { kind: "runner_broken"; brokenSuites: string[]; detail: string }
  | { kind: "story_red"; storyRed: { id: string; failure_message?: string }[] }
  | {
      kind: "regression";
      breaks: { id: string; failure_message?: string }[];
      preExistingRed: number;
    };

export function finalGateVerdict(
  finalRun: GateRunInput,
  expectedTestIds: ReadonlySet<string>,
  fullBaselineGreen: ReadonlySet<string>
): GateVerdict {
  if (!finalRun.ran) {
    const broken = finalRun.suiteErrors ?? [];
    return {
      kind: "runner_broken",
      brokenSuites: broken.length > 0 ? broken.map((b) => b.suite) : ["(unknown)"],
      detail:
        broken.length > 0
          ? broken.map((b) => `[${b.suite}] ${b.error}`).join("; ")
          : finalRun.error ?? "(no detail)",
    };
  }
  const red = finalRun.tests.filter((t) => t.status !== "passed");
  const storyRed = red.filter((t) => expectedTestIds.has(t.id));
  if (storyRed.length > 0) {
    return {
      kind: "story_red",
      storyRed: storyRed.map((t) => ({
        id: t.id,
        ...(t.failure_message ? { failure_message: t.failure_message } : {}),
      })),
    };
  }
  const transitiveBreaks = red.filter(
    (t) => !expectedTestIds.has(t.id) && fullBaselineGreen.has(t.id)
  );
  const preExistingRed = red.filter(
    (t) => !expectedTestIds.has(t.id) && !fullBaselineGreen.has(t.id)
  ).length;
  if (transitiveBreaks.length > 0) {
    return {
      kind: "regression",
      breaks: transitiveBreaks.map((t) => ({
        id: t.id,
        ...(t.failure_message ? { failure_message: t.failure_message } : {}),
      })),
      preExistingRed,
    };
  }
  return {
    kind: "pass",
    fullGreen: finalRun.tests.filter((t) => t.status === "passed").length,
    preExistingRed,
  };
}
