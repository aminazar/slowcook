/**
 * design #9 — HITL role gates: the gate-integrity core.
 *
 * Decides whether a pipeline stage may proceed past a human-review gate.
 * The load-bearing security property: an approval only counts if it
 * comes from a HUMAN identity that is in the configured handle-list for
 * the required role. A bot/agent approval, or an approval from someone
 * not assigned that role, NEVER satisfies a gate. This is what makes the
 * halt unforgeable by the automation driving the pipeline.
 */
import { resolveRole, type ReviewersConfig } from "./reviewers.js";

export type Role = "pm" | "designer" | "qa";
export type Stage = "refine" | "plate" | "brew" | string;

export interface Gate {
  stage: Stage;
  requiredRoles: Role[];
  approvalSignal: "review" | "comment";
  onRejectTarget: Stage;
}

export interface Approval {
  /** GitHub handle of the approver. */
  byHandle: string;
  state: "approved" | "rejected" | "commented";
  /** bot = slowcook-*[bot] / the driving agent; human = a real reviewer. */
  identityType: "human" | "bot";
}

export interface GateVerdict {
  satisfied: boolean;
  /** required roles lacking a valid human approval. */
  missingRoles: Role[];
  /** a valid human reviewer for a required role rejected. */
  rejected: boolean;
  /** human-readable summary. */
  reason: string;
}

/**
 * The standard pipeline gates. refine is signed off by a PM, plate by a
 * designer, and brew needs BOTH qa and designer before code ships.
 */
export const DEFAULT_GATES: Gate[] = [
  { stage: "refine", requiredRoles: ["pm"], approvalSignal: "review", onRejectTarget: "refine" },
  { stage: "plate", requiredRoles: ["designer"], approvalSignal: "review", onRejectTarget: "plate" },
  { stage: "brew", requiredRoles: ["qa", "designer"], approvalSignal: "review", onRejectTarget: "brew" },
];

/**
 * True when `approvals` contains an approval in `state` for role `role`
 * that is BOTH human-authored AND from a handle configured for that role
 * in `reviewers`. Handle matching is case-insensitive (both sides
 * lowercased). This is the single chokepoint enforcing the integrity
 * property — a bot identity or an unconfigured handle can never pass.
 */
function hasValidSignal(
  reviewers: ReviewersConfig,
  approvals: Approval[],
  role: Role,
  state: "approved" | "rejected",
): boolean {
  const allowed = new Set(resolveRole(reviewers, role)); // already lowercased on load
  return approvals.some(
    (a) =>
      a.identityType === "human" &&
      a.state === state &&
      allowed.has(a.byHandle.toLowerCase()),
  );
}

/**
 * Evaluate a gate against the reviewer roster and the observed approvals.
 *
 * - A valid approval for role R = human + state 'approved' + handle in
 *   the role's configured list.
 * - A valid rejection for role R = same, but state 'rejected'.
 * - `rejected` is true if ANY required role has a valid rejection; a
 *   rejected gate is never satisfied (and routes back to onRejectTarget,
 *   handled by the caller).
 * - `missingRoles` lists required roles with no valid approval.
 * - `satisfied` requires every required role to have a valid approval
 *   AND no valid rejection.
 */
export function isGateSatisfied(
  gate: Gate,
  reviewers: ReviewersConfig,
  approvals: Approval[],
): GateVerdict {
  const rejectingRoles = gate.requiredRoles.filter((role) =>
    hasValidSignal(reviewers, approvals, role, "rejected"),
  );
  const missingRoles = gate.requiredRoles.filter(
    (role) => !hasValidSignal(reviewers, approvals, role, "approved"),
  );
  const rejected = rejectingRoles.length > 0;
  const satisfied = !rejected && missingRoles.length === 0;

  let reason: string;
  if (rejected) {
    reason = `rejected by ${rejectingRoles.join(", ")}`;
  } else if (missingRoles.length > 0) {
    reason = `blocked: missing ${missingRoles.join(", ")} approval`;
  } else {
    reason = "satisfied";
  }

  return { satisfied, missingRoles, rejected, reason };
}
