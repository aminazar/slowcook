/**
 * Project-level gate declarations — `.brewing/gates.yaml` (plan §5a).
 *
 * Each pipeline artifact kind declares who closes its gate:
 *   - "agent": the reviewer agent (taste) may merge on approve.
 *   - "human": agents review and advise, but the MERGE IS THE PM's —
 *     taste posts its verdict and stops.
 *
 * Amin's standing rule (2026-08-21): vibe (UI/mock approval), eye (QA
 * verdicts), and brew (implementation merges) stay human — visual and
 * QA judgment is not delegated. Defaults encode that: a repo with no
 * gates.yaml gets agent-mergeable spec/tests and human everything else.
 *
 * File shape:
 *   gates:
 *     spec: agent
 *     tests: agent
 *     brew: human
 *     vibe: human
 *     eye: human
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";

export type GateOwner = "agent" | "human";
export type GateKind = "spec" | "tests" | "brew" | "vibe" | "eye";

export const GATE_DEFAULTS: Record<GateKind, GateOwner> = {
  spec: "agent",
  tests: "agent",
  brew: "human",
  vibe: "human",
  eye: "human",
};

/** Load the project's gate declarations; unknown/invalid values fall back
 *  to the (conservative) defaults — never fail open on a typo. */
export function loadGates(repoRoot: string): Record<GateKind, GateOwner> {
  const gates = { ...GATE_DEFAULTS };
  try {
    const raw = YAML.parse(
      readFileSync(join(repoRoot, ".brewing", "gates.yaml"), "utf8")
    ) as { gates?: Record<string, unknown> };
    for (const kind of Object.keys(gates) as GateKind[]) {
      const v = raw?.gates?.[kind];
      if (v === "agent" || v === "human") gates[kind] = v;
    }
  } catch {
    /* no file — defaults stand */
  }
  return gates;
}
