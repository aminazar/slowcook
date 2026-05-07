/**
 * 0.19.0-alpha.7 (#64) — pure scoring + filtering helpers for the
 * refactor command. No IO; testable in isolation.
 */

import type { ProposalAssessment, RefactorProposal } from "./types.js";

/**
 * Compute the cost / benefit / benefit-per-cost numbers for one
 * proposal. Cost is `abs(estimatedLocDelta) * filesAffected.length`
 * (clamped to ≥1 so the ratio is finite for zero-cost edge cases).
 */
export function assessProposal(p: RefactorProposal): ProposalAssessment {
  const fileCount = p.filesAffected.length || 0;
  const rawCost = Math.abs(p.estimatedLocDelta) * Math.max(1, fileCount);
  const cost = Math.max(1, rawCost);
  const benefit = p.estimatedValueScore;
  return {
    proposalId: p.id,
    costScore: cost,
    benefitScore: benefit,
    benefitPerCost: benefit / cost,
  };
}

/**
 * Match a single file path against a glob-ish scope pattern. Supports:
 *   - exact match: "src/foo.ts"
 *   - directory prefix: "src/" (matches anything under src/)
 *   - star at the end: "src/components/*" (one segment after)
 *   - double-star: "src/**" (any depth)
 *
 * Pure regex translation; no fs lookup.
 */
export function matchesScope(filePath: string, pattern: string): boolean {
  if (pattern === filePath) return true;
  if (pattern.endsWith("/")) {
    return filePath.startsWith(pattern);
  }
  if (pattern.endsWith("/**")) {
    return filePath.startsWith(pattern.slice(0, -3) + "/") || filePath === pattern.slice(0, -3);
  }
  if (pattern.endsWith("/*")) {
    const dir = pattern.slice(0, -2);
    if (!filePath.startsWith(dir + "/")) return false;
    const rest = filePath.slice(dir.length + 1);
    return !rest.includes("/");
  }
  return false;
}

/**
 * Filter proposals to those whose `filesAffected` ALL match at least
 * one scope pattern. A proposal that touches even one out-of-scope
 * file is excluded entirely (boundedness rule — refactors stay
 * surgical).
 */
export function filterProposalsByScope(
  proposals: RefactorProposal[],
  scope: string[],
): RefactorProposal[] {
  if (scope.length === 0) return proposals.slice();
  return proposals.filter((p) =>
    p.filesAffected.every((f) => scope.some((pat) => matchesScope(f, pat))),
  );
}

/**
 * Rank a list of proposals by benefit-per-cost (descending). Returns
 * a NEW array of [proposal, assessment] pairs; doesn't mutate input.
 * Stable for ties (preserves original order).
 */
export function rankProposals(
  proposals: RefactorProposal[],
): Array<{ proposal: RefactorProposal; assessment: ProposalAssessment }> {
  const indexed = proposals.map((p, i) => ({
    proposal: p,
    assessment: assessProposal(p),
    origIndex: i,
  }));
  indexed.sort((a, b) => {
    const diff = b.assessment.benefitPerCost - a.assessment.benefitPerCost;
    if (diff !== 0) return diff;
    return a.origIndex - b.origIndex; // stable
  });
  return indexed.map(({ proposal, assessment }) => ({ proposal, assessment }));
}
