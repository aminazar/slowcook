/**
 * 0.19.0-alpha.7 (#64) — refactor command data shapes.
 *
 * The refactor command takes a list of candidate refactors (proposals)
 * + computes per-proposal cost/benefit, filters by codebase scope,
 * and ranks them. Proposals come from a source the cli treats as
 * opaque today — could be hand-authored JSON, recon emissions, or a
 * future LLM proposer agent. The scoring + filtering logic stays
 * separate so any source feeds into the same ranking.
 *
 * Goals:
 *   - Boundedness: caller specifies scope (e.g. `src/components/**`)
 *     so refactors don't sprawl across the repo.
 *   - Cheapness-first: prefer high-value low-cost proposals; defer
 *     expensive ones until they pay back.
 *   - Auditability: each proposal carries a rationale + estimated
 *     deltas so the cli can show its work + a PM can sanity-check.
 *
 * Out of scope for α.7 (deferred):
 *   - LLM-backed proposer that READS the codebase + suggests
 *     refactors. The pure ranking layer ships first; proposer comes
 *     when the data shape has settled empirically.
 *   - Auto-application. α.7 ranks + reports; a future α may apply.
 */

/**
 * A single candidate refactor. The cli treats `id` as opaque (caller
 * picks; e.g., a slug or hash). `filesAffected` is canonical (no
 * globs in the proposal itself — globs live in scope filters).
 */
export interface RefactorProposal {
  /** Stable identifier, caller-chosen. */
  id: string;
  /** One-line summary (≤120 chars). Shown in ranked output. */
  title: string;
  /** What the refactor changes + WHY it's worth doing. */
  rationale: string;
  /** Concrete file paths the refactor would touch. Repo-relative. */
  filesAffected: string[];
  /** Net lines changed estimate (added - removed). Negative is fine
   *  (refactors that reduce LOC are usually high-value). */
  estimatedLocDelta: number;
  /** Subjective value score, 0-10. Caller's job to populate. */
  estimatedValueScore: number;
  /** Optional: external value signals (e.g., dup-count eliminated,
   *  cyclomatic-complexity drop). Surface-only; no scoring weight
   *  applied unless the caller folds them into estimatedValueScore. */
  evidence?: Record<string, number | string>;
}

/**
 * The cost/benefit assessment of a single proposal. Pure: derived
 * from the proposal alone (no IO).
 */
export interface ProposalAssessment {
  proposalId: string;
  /** Cost: |estimatedLocDelta| × number of files (handwave, but
   *  monotonic with reviewer effort). Higher = more expensive. */
  costScore: number;
  /** Benefit: estimatedValueScore as-is. */
  benefitScore: number;
  /** Ratio: benefit / max(cost, 1). Higher = better return per unit
   *  effort. Used as the default ranking key. */
  benefitPerCost: number;
}
