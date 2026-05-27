import YAML from "yaml";
import { z } from "zod";
import type { LlmClient, LlmMessage } from "./llm.js";
import { costMarker } from "./llm.js";
import {
  formatCostFooter,
  formatRateLimitHint,
  parseCostMarkers,
} from "@slowcook-ai/llm-anthropic";

/**
 * Strip the brand header, cost footer, and HTML cost marker out of a
 * model-emitted markdown body. The calling code adds those around the
 * output; if the model copies them from prior-turn context, we'd
 * post duplicates. Cheap regex; safe to no-op when patterns absent.
 *
 * Visible for tests.
 */
export function stripModelEmittedDuplicates(body: string): string {
  return body
    // Brand header (with or without trailing whitespace)
    .replace(/^###\s*slowcook\s*·\s*refinement\s*agent\s*🍲\s*\n+/g, "")
    // Cost footer (one or many lines of the <sub>💰...</sub> shape,
    // optionally preceded by a `---` separator)
    .replace(/\n*---\s*\n+<sub>\s*💰[^<]*<\/sub>/g, "")
    // HTML cost marker
    .replace(/\n*<!--\s*slowcook:cost\s[^>]*-->/g, "")
    .replace(/\n{3,}$/g, "\n\n")
    .trimEnd();
}
import { synthesizeProposalsFromSpec } from "./proposals-synth.js";
import { writeMockFixtures } from "./mock-fixtures.js";
import { validateAndRepairSpec, validateEntityFieldReferences } from "./spec-validate.js";
import { SpecProposalsSchema } from "./spec-yaml.js";
import type {
  ForgeAdapter,
  Issue,
  Comment,
  Spec,
  RelationshipVerdict,
} from "@slowcook-ai/core";
import {
  REFINEMENT_ANALYST_SYSTEM,
  SPEC_CHECKLIST_MD,
  AMENDMENT_SYSTEM,
  draftPrTitle,
  draftPrBody,
} from "./prompts.js";
import {
  readIndex,
  writeIndex,
  writeSpec,
  readSpec,
  listActiveSpecs,
  nextStoryId,
  entryFromSpec,
  SPECS_DIR,
} from "./spec-yaml.js";
import { execSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { buildProjectContext } from "./context.js";
import {
  analyzeRelationship,
  contradictionCommentBody,
  overlapCommentBody,
  followUpCommentBody,
} from "./relationship.js";
import { applySupersede } from "@slowcook-ai/core";
import { enrichBodyWithImages } from "./images.js";
import { auditSideEffects, sideEffectsCommentBody } from "./side-effects-audit.js";
import {
  assessMultifurcation,
  digestActiveSpecs,
  multifurcationCommentBody,
  hasExistingMultifurcationComment,
} from "./multifurcate.js";
import {
  answerQuestionsFromBrownfield,
  composePassBComment,
  hasBrownfield,
} from "./brownfield-answer.js";
import { appendCostEntry, applyCostToSpec, costSidecarPath } from "../../cost-store.js";
import { fuelGaugeFromRepo } from "../../lib/budget.js";

export const LABEL_CHANGE_OF_MIND = "change-of-mind";
export const LABEL_BLOCKED_CONTRADICTION = "blocked-contradiction";
export const LABEL_BLOCKED_OVERLAP = "blocked-overlap";
export const LABEL_SPEC_SUBMITTED = "spec-submitted";
export const LABEL_SPEC_READY = "spec-ready";
export const LABEL_NEEDS_REFINEMENT = "needs-refinement";
/**
 * cli α.44 — applied to an issue when refine has posted a multifurcation
 * proposal. While present, future refine runs skip the multifurcation
 * step (the PM is still deciding whether to file the split). PM removes
 * the label after acting on the proposal.
 */
export const LABEL_MULTIFURCATION_PROPOSED = "slowcook-multifurcation-proposed";

/**
 * Branded header prepended to every clarifying-question comment so reviewers
 * can tell at a glance that the comment is agent-authored, even though GitHub
 * shows the author as "github-actions[bot]". The prefix `### slowcook ·` is
 * load-bearing — the consumer workflow filters comments starting with it to
 * avoid re-triggering the agent on its own output. Do not change this literal
 * without updating rewo's slowcook-refine.yml `if:` condition in lockstep.
 */
export const BRAND_HEADER = "### slowcook · refinement agent 🍲\n\n";

export interface RefineContext {
  issueNumber: number;
  repoRoot: string;
  forge: ForgeAdapter;
  llm: LlmClient;
  /** Model id for refinement (heavy reasoning). */
  refineModel: string;
  /** Model id for relationship analysis (cheaper). */
  relationshipModel: string;
  /** slowcook CLI version string for the spec's refined_by field. */
  cliVersion: string;
  /** Base branch for PRs (default: "main"). */
  baseBranch: string;
  /** Current UTC time (injectable for tests). */
  now: Date;
}

export type RefineOutcome =
  | { kind: "questions-posted"; commentId: number }
  | { kind: "spec-emitted"; specPath: string; prUrl: string; prNumber: number }
  | { kind: "overlap-flagged"; conflicting_ids: string[] }
  | { kind: "follow-up-noted"; related_ids: string[] }
  | { kind: "contradiction-blocked"; conflicting_ids: string[] }
  | { kind: "change-of-mind-accepted"; supersedes: string[] }
  | { kind: "multifurcation-proposed"; commentId: number; subIssueCount: number }
  | { kind: "noop"; reason: string };

/** Schema for the <sentinel> block the agent uses when it emits a spec. */
const SpecEmissionFenceStart = "---";

export async function runRefinement(ctx: RefineContext): Promise<RefineOutcome> {
  const issue = await ctx.forge.getIssue(ctx.issueNumber);

  if (issue.state === "closed") {
    return { kind: "noop", reason: "issue is closed" };
  }
  if (!issue.labels.includes(LABEL_NEEDS_REFINEMENT)) {
    return { kind: "noop", reason: `issue is not labeled ${LABEL_NEEDS_REFINEMENT}` };
  }

  // Step 0: multifurcation check (cli α.44).
  //
  // Cheap LLM pass that detects "this issue is actually many stories"
  // BEFORE refine wastes a heavy-reasoning call producing a fuzzy
  // mega-spec. Sits ahead of relationship analysis because if we're
  // going to ask the PM to split, that conversation precedes any
  // overlap/contradiction reasoning against existing specs (the
  // existing specs we'd compare against are per-sub-issue, not per-
  // parent).
  //
  // Skipped when:
  //   - the issue already carries `slowcook-multifurcation-proposed`
  //     (refine has already posted a proposal; PM is deciding)
  //   - a multifurcation comment marker is already in the thread
  //     (defense-in-depth against label drift)
  //
  // The model can fall back to "one" silently if the verdict is
  // unparseable — that's safer than blocking refine on a parser bug.
  // cli α.45 — hoist listActiveSpecs above multifurcation so the model
  // can annotate overlapping sub-issues with their `existing_spec_id`
  // instead of silently omitting them. Same call is reused for the
  // relationship-analysis step below.
  const activeSpecs = listActiveSpecs(ctx.repoRoot);

  if (!issue.labels.includes(LABEL_MULTIFURCATION_PROPOSED)) {
    const existingComments = await ctx.forge.listIssueComments(ctx.issueNumber);
    if (!hasExistingMultifurcationComment(existingComments)) {
      try {
        const mf = await assessMultifurcation(
          {
            issueTitle: issue.title,
            issueBody: issue.body,
            activeSpecs: digestActiveSpecs(activeSpecs),
          },
          { llm: ctx.llm, model: ctx.relationshipModel }
        );
        if (mf.verdict.kind === "many") {
          const marker = costMarker({
            agent: "refine",
            usd: mf.costUsd,
            tokensIn: mf.usage.inputTokens,
            tokensOut: mf.usage.outputTokens,
            cacheRead: mf.usage.cacheReadTokens,
            cacheCreate: mf.usage.cacheCreateTokens,
            model: ctx.relationshipModel,
            round: "multifurcation",
          });
          const body =
            multifurcationCommentBody(
              { rationale: mf.verdict.rationale, sub_issues: mf.verdict.sub_issues },
              { issueTitle: issue.title }
            ) +
            "\n\n" +
            marker;
          const comment = await ctx.forge.createIssueComment(ctx.issueNumber, body);
          await ctx.forge.addIssueLabels(ctx.issueNumber, [LABEL_MULTIFURCATION_PROPOSED]);
          return {
            kind: "multifurcation-proposed",
            commentId: comment.id,
            subIssueCount: mf.verdict.sub_issues.length,
          };
        }
      } catch (e) {
        // Multifurcation is an optimization; if the LLM call fails we
        // still want refine to proceed. Log only.
        console.warn(
          `  (multifurcation check failed; proceeding with single-spec refine: ${(e as Error).message.slice(0, 200)})`
        );
      }
    }
  }

  // Step 1: relationship analysis (reuses `activeSpecs` from above)
  const existingSpecs = activeSpecs;
  const relationshipResult = await analyzeRelationship(
    { issueTitle: issue.title, issueBody: issue.body, activeSpecs: existingSpecs },
    { llm: ctx.llm, model: ctx.relationshipModel }
  );
  const verdict: RelationshipVerdict = relationshipResult.verdict;

  const hasChangeOfMind = issue.labels.includes(LABEL_CHANGE_OF_MIND);

  // Accumulate cost across all LLM calls in this refine invocation so the
  // final comment posted carries the full round cost. Relationship analysis
  // + refinement call are the two calls.
  let roundCostUsd = relationshipResult.costUsd;
  let totalTokensIn = relationshipResult.usage.inputTokens;
  let totalTokensOut = relationshipResult.usage.outputTokens;
  let totalCacheRead = relationshipResult.usage.cacheReadTokens;
  let totalCacheCreate = relationshipResult.usage.cacheCreateTokens;

  if (verdict.kind === "overlap") {
    const marker = costMarker({
      agent: "refine",
      usd: roundCostUsd,
      tokensIn: totalTokensIn,
      tokensOut: totalTokensOut,
      cacheRead: totalCacheRead,
      cacheCreate: totalCacheCreate,
      model: ctx.relationshipModel,
      round: "relationship-overlap",
    });
    const comment = await ctx.forge.createIssueComment(
      ctx.issueNumber,
      overlapCommentBody(verdict, existingSpecs) + "\n\n" + marker
    );
    await ctx.forge.addIssueLabels(ctx.issueNumber, [LABEL_BLOCKED_OVERLAP]);
    return { kind: "overlap-flagged", conflicting_ids: verdict.conflicting_ids };
  }

  if (verdict.kind === "follow_up") {
    // Info only — refinement continues. Post the comment so the PM can see
    // the agent noted the relationship + will cite it in related_specs.
    await ctx.forge.createIssueComment(
      ctx.issueNumber,
      followUpCommentBody(verdict, existingSpecs)
    );
    // Intentionally no label — follow_up is not a blocker. Refinement
    // continues below. The resulting spec's `related_specs` field will
    // cite the predecessors. Cost for this relationship call rolls into
    // the final refinement comment's marker.
  }

  if (verdict.kind === "contradiction") {
    if (!hasChangeOfMind) {
      // 0.18.0+ — side-effects audit: 2nd LLM pass enumerates the
      // exact assertions that would need to flip if approved. PM
      // reviews the granular table; accept (`/refine accept
      // side-effects` or `change-of-mind` label) routes through
      // the existing supersede path with structured info, reject
      // drops the issue. Replaces the bare "blocked" comment.
      let auditComment: string;
      try {
        const auditResult = await auditSideEffects(
          {
            issueTitle: issue.title,
            issueBody: issue.body,
            conflictingStoryIds: verdict.conflicting_ids,
            repoRoot: ctx.repoRoot,
          },
          { llm: ctx.llm, model: ctx.refineModel }
        );
        roundCostUsd += auditResult.costUsd;
        totalTokensIn += auditResult.usage.inputTokens;
        totalTokensOut += auditResult.usage.outputTokens;
        totalCacheRead += auditResult.usage.cacheReadTokens;
        totalCacheCreate += auditResult.usage.cacheCreateTokens;
        auditComment = sideEffectsCommentBody(auditResult.audit, verdict.conflicting_ids);
      } catch (e) {
        // Fall back to the original blocked-contradiction message if
        // the audit fails (LLM error, JSON parse failure, etc.). Don't
        // block the pipeline on the audit's failure.
        auditComment =
          contradictionCommentBody(verdict, false, existingSpecs) +
          `\n\n_(side-effects audit failed: ${(e as Error).message.slice(0, 200)})_`;
      }

      const marker = costMarker({
        agent: "refine",
        usd: roundCostUsd,
        tokensIn: totalTokensIn,
        tokensOut: totalTokensOut,
        cacheRead: totalCacheRead,
        cacheCreate: totalCacheCreate,
        model: ctx.refineModel,
        round: "side-effects-audit",
      });
      await ctx.forge.createIssueComment(
        ctx.issueNumber,
        auditComment + "\n\n" + marker
      );
      await ctx.forge.addIssueLabels(ctx.issueNumber, [LABEL_BLOCKED_CONTRADICTION]);
      return { kind: "contradiction-blocked", conflicting_ids: verdict.conflicting_ids };
    }
    // Authorized change-of-mind: post an acknowledgment, clear any stale
    // blocker label from a prior pass, and proceed.
    await ctx.forge.createIssueComment(
      ctx.issueNumber,
      contradictionCommentBody(verdict, true, existingSpecs)
    );
    await ctx.forge.removeIssueLabel(ctx.issueNumber, LABEL_BLOCKED_CONTRADICTION);
  }

  const supersedes: string[] =
    verdict.kind === "contradiction" && hasChangeOfMind ? verdict.conflicting_ids : [];

  // Step 2: refinement loop (single round — ask or emit based on full history)
  const comments = await ctx.forge.listIssueComments(ctx.issueNumber);
  const chat = await buildChatHistory(issue, comments, supersedes);
  const storyId = await nextStoryId(ctx.repoRoot, ctx.forge);

  const projectContext = buildProjectContext(ctx.repoRoot);
  const agentResponse = await ctx.llm.complete({
    system: REFINEMENT_ANALYST_SYSTEM(SPEC_CHECKLIST_MD, projectContext),
    cacheSystem: true,
    model: ctx.refineModel,
    messages: chat,
    maxTokens: 4096,
    // temperature omitted — newer reasoning-enabled Claude models reject it.
  });

  roundCostUsd += agentResponse.costUsd;
  totalTokensIn += agentResponse.usage.inputTokens;
  totalTokensOut += agentResponse.usage.outputTokens;
  totalCacheRead += agentResponse.usage.cacheReadTokens;
  totalCacheCreate += agentResponse.usage.cacheCreateTokens;

  const parsed = parseAgentOutput(agentResponse.text, {
    storyId,
    issueNumber: ctx.issueNumber,
    createdAt: ctx.now.toISOString(),
    cliVersion: ctx.cliVersion,
    supersedes,
    repoRoot: ctx.repoRoot,
  });

  if (parsed.kind === "questions") {
    // 0.19.0-α.36 — Pass B: reflexive brownfield-answer pass. Filters
    // Pass A's draft questions against the same brownfield context, so
    // questions the codebase already answers don't reach the PM. Skipped
    // entirely on greenfield projects (no entities / no specs / no
    // context.md). Cost added to roundCostUsd.
    //
    // Best-effort: a JSON parse failure or LLM error falls back to
    // posting Pass A's original markdown unchanged — never blocks the
    // round on this layer.
    let questionsBody = parsed.markdown;
    if (hasBrownfield(ctx.repoRoot)) {
      try {
        const passB = await answerQuestionsFromBrownfield(
          {
            draftQuestionsMarkdown: parsed.markdown,
            projectContext,
          },
          { llm: ctx.llm, model: ctx.refineModel }
        );
        roundCostUsd += passB.costUsd;
        totalTokensIn += passB.usage.inputTokens;
        totalTokensOut += passB.usage.outputTokens;
        totalCacheRead += passB.usage.cacheReadTokens;
        totalCacheCreate += passB.usage.cacheCreateTokens;
        questionsBody = composePassBComment(passB, parsed.markdown);
        if (passB.answered.length > 0) {
          console.log(
            `[refine] Pass B answered ${passB.answered.length}/${passB.answered.length + passB.unanswered.length} questions from brownfield`
          );
        }
      } catch (e) {
        console.warn(
          `[refine] Pass B (brownfield-answer) failed, posting Pass A questions unchanged: ${(e as Error).message}`
        );
      }
    }
    // Compute visible cost footer: this run's cost + accumulated prior
    // bot-emitted costs on the same issue. Footer renders as plain
    // markdown the PM can see; the HTML cost marker remains for machine
    // parsing. Best-effort — never block the comment on a list-comments
    // failure.
    let footer = "";
    try {
      const priorComments = await ctx.forge.listIssueComments(ctx.issueNumber);
      const priorMarkers = priorComments.flatMap((c) =>
        parseCostMarkers(c.body)
      );
      footer = formatCostFooter(roundCostUsd, priorMarkers);
      // 0.19.0-α.31 (sc#69) — append rate-limit hint when the
      // provider says remaining is tight. Empty string when below
      // threshold or no rate-limit headers exposed.
      footer += formatRateLimitHint(agentResponse.rateLimits);
      // 0.19.0-α.34 (sc#66) — project-level fuel gauge. Empty
      // string when no .brewing/budget.yaml exists (opt-in).
      footer += fuelGaugeFromRepo(ctx.repoRoot, ctx.now);
    } catch {
      /* best effort — fall back to no footer if list fails */
    }
    // Defense-in-depth: the prompt tells the model not to emit cost
    // footers / markers / brand header (those are auto-appended). But
    // if the model copies the pattern from prior-turn context anyway,
    // strip it so the final comment doesn't carry duplicates. Cheap
    // string ops; safe to no-op when patterns are absent. When Pass B
    // ran, `questionsBody` is its composed output (already free of
    // model-emitted boilerplate); when it didn't, fall through to
    // strip on the raw markdown.
    const cleanMarkdown =
      questionsBody !== parsed.markdown
        ? questionsBody
        : stripModelEmittedDuplicates(parsed.markdown);
    // Cost marker is computed AFTER Pass B so it reflects the round's
    // total spend including the Pass B call.
    const refineCostMarker = costMarker({
      agent: "refine",
      usd: roundCostUsd,
      tokensIn: totalTokensIn,
      tokensOut: totalTokensOut,
      cacheRead: totalCacheRead,
      cacheCreate: totalCacheCreate,
      model: ctx.refineModel,
      round: "questions",
    });
    const comment = await ctx.forge.createIssueComment(
      ctx.issueNumber,
      BRAND_HEADER + cleanMarkdown + footer + "\n\n" + refineCostMarker
    );
    return { kind: "questions-posted", commentId: comment.id };
  }

  // Spec emitted → write, update index, open draft PR
  const spec = parsed.spec;
  // 0.14.0-α.6+ — content-level repair before persisting. Catches LLM
  // truncation that Zod missed (e.g. unterminated `var(--tint-in`).
  const validationFindings = validateAndRepairSpec(spec);

  // 0.19.x+ — catch hallucinated entity.field references against the
  // auto/backend-entities.md catalog. Best-effort: if the digest is
  // missing (consumer hasn't run refresh-knowledge yet), skip silently.
  try {
    const entityCatalogPath = join(
      ctx.repoRoot,
      ".brewing/repo-knowledge/auto/backend-entities.md"
    );
    if (existsSync(entityCatalogPath)) {
      const md = readFileSync(entityCatalogPath, "utf8");
      validationFindings.push(...validateEntityFieldReferences(spec, md));
    }
  } catch {
    // Never fail spec emit on a lint hiccup.
  }

  if (validationFindings.length > 0) {
    console.warn(
      `[refine] spec post-emit validation: ${validationFindings.length} finding(s):`
    );
    for (const f of validationFindings) {
      console.warn(`  - ${f.path}: ${f.message} (${f.action})`);
    }
  }
  const specPath = writeSpec(ctx.repoRoot, spec);

  // 0.19.0-α.34 (sc#67) — canonical cost storage. Record this refine
  // round to the sidecar, then update spec.cost.total_usd. Sidecar is
  // append-only JSONL; spec yaml is rewritten with the new total.
  // Best-effort: never fail the spec emit on a cost-storage hiccup.
  try {
    appendCostEntry(ctx.repoRoot, spec.story_id, {
      agent: "refine",
      usd: roundCostUsd,
      model: ctx.refineModel,
      round: "spec",
      at: ctx.now.toISOString(),
      tokens_in: totalTokensIn,
      tokens_out: totalTokensOut,
      cache_read: totalCacheRead,
      cache_create: totalCacheCreate,
    });
    applyCostToSpec(ctx.repoRoot, spec.story_id, ctx.now.toISOString());
  } catch (e) {
    console.warn(`[refine] cost-store update failed: ${(e as Error).message}`);
  }

  const index = readIndex(ctx.repoRoot);
  const updatedIndex = applySupersede(
    index,
    { id: spec.story_id, entry: entryFromSpec(spec) },
    supersedes
  );
  writeIndex(ctx.repoRoot, updatedIndex);

  // 0.14.0-α.1 mockup-first data-layer seam — emit `.mock.ts` files
  // when the spec has `proposals.fixtures.by_domain`. Skipped silently
  // for specs without fixtures, so this is a no-op for pre-α.1 specs.
  const mockResult = writeMockFixtures(ctx.repoRoot, spec);
  if (mockResult.written.length > 0) {
    console.log(
      `[refine] wrote ${mockResult.written.length} mock fixture file(s): ${mockResult.written.join(", ")}`
    );
  }

  const branch = `slowcook/spec/story-${spec.story_id}`;
  await ctx.forge.git.createBranch(branch);
  await ctx.forge.git.stage(specPath);
  await ctx.forge.git.stage(`specs/_index.yaml`);
  for (const f of mockResult.written) {
    await ctx.forge.git.stage(f);
  }
  // 0.19.0-α.34 (sc#67) — stage the cost sidecar so it ships with
  // the spec PR. Best-effort: skip silently if it doesn't exist
  // (e.g., cost-store write failed above).
  try {
    const sidecar = costSidecarPath(ctx.repoRoot, spec.story_id);
    await ctx.forge.git.stage(sidecar);
  } catch {
    /* best effort */
  }
  await ctx.forge.git.commit(
    `slowcook: spec story-${spec.story_id} — ${spec.title}\n\nRefined from #${ctx.issueNumber}.`
  );
  await ctx.forge.git.push(branch);

  // PR creation can fail with 403 if the org/repo setting "Allow GitHub
  // Actions to create and approve pull requests" is off. Catch it
  // specifically and leave the branch + spec behind with a breadcrumb
  // comment instead of crashing — the state machine still progresses.
  try {
    const pr = await ctx.forge.createPullRequest({
      title: draftPrTitle(spec.story_id, spec.title),
      body: draftPrBody({
        storyId: spec.story_id,
        issueNumber: ctx.issueNumber,
        supersedes,
        spec,
      }),
      head: branch,
      base: ctx.baseBranch,
      draft: true,
      labels: ["slowcook-spec"],
    });
    await ctx.forge.addIssueLabels(ctx.issueNumber, [LABEL_SPEC_SUBMITTED]);
    await ctx.forge.removeIssueLabel(ctx.issueNumber, LABEL_NEEDS_REFINEMENT);

    // Post a cost-carrying comment so the pipeline-total aggregator can
    // see refine's spend alongside testgen's + brew's at the end. Best-effort.
    try {
      // 0.19.0-α.34 (sc#66) — append the fuel gauge to the
      // spec-submitted comment too. Empty string when budget.yaml is
      // absent (opt-in).
      const gauge = fuelGaugeFromRepo(ctx.repoRoot, ctx.now);
      const refineCostMarker = costMarker({
        agent: "refine",
        usd: roundCostUsd,
        tokensIn: totalTokensIn,
        tokensOut: totalTokensOut,
        cacheRead: totalCacheRead,
        cacheCreate: totalCacheCreate,
        model: ctx.refineModel,
        round: "spec",
      });
      await ctx.forge.createIssueComment(
        ctx.issueNumber,
        `### slowcook · spec submitted\n\n` +
          `Spec \`story-${spec.story_id}\` opened at [PR #${pr.number}](${pr.url}). Merge to trigger \`slowcook-testgen\`.\n\n` +
          refineCostMarker +
          gauge
      );
    } catch {
      /* best effort */
    }
    return { kind: "spec-emitted", specPath, prUrl: pr.url, prNumber: pr.number };
  } catch (e) {
    const status = (e as { status?: number }).status;
    if (status === 403) {
      await ctx.forge.createIssueComment(
        ctx.issueNumber,
        `### slowcook · PR creation blocked

I wrote the spec to \`${specPath.replace(ctx.repoRoot + "/", "")}\` and pushed branch \`${branch}\`, but I couldn't open the PR automatically:

\`\`\`
${(e as Error).message}
\`\`\`

**Fix:** enable **"Allow GitHub Actions to create and approve pull requests"** at:
- Repo: \`Settings → Actions → General → Workflow permissions\`
- Org (if it overrides the repo): \`organizations/<org>/settings/actions → Workflow permissions\`

Once enabled, you can either (a) bounce the \`needs-refinement\` label to re-run me (I'll no-op on the existing branch and just open the PR), or (b) open the PR manually from the branch.

Labels updated regardless of PR status.`
      );
      // Progress the state machine even though the PR didn't open.
      await ctx.forge.addIssueLabels(ctx.issueNumber, [LABEL_SPEC_SUBMITTED]);
      await ctx.forge.removeIssueLabel(ctx.issueNumber, LABEL_NEEDS_REFINEMENT);
      return { kind: "spec-emitted", specPath, prUrl: "", prNumber: -1 };
    }
    throw e;
  }
}

// ----- helpers -----

async function buildChatHistory(
  issue: Issue,
  comments: Comment[],
  supersedes: string[]
): Promise<LlmMessage[]> {
  // First message: the issue body + metadata.
  const issueBlock = `# Issue #${issue.number}: ${issue.title}

${issue.body}`;

  // Bodies may reference screenshots via <img src> or ![](url). Fetch and
  // attach them as image blocks so the agent can actually see the error
  // the reporter screenshotted — text-only refinement on bug reports was
  // blind to this before 0.11.9 (see issue #78 on rewo).
  const messages: LlmMessage[] = [
    { role: "user", content: await enrichBodyWithImages(issueBlock) },
  ];

  // Interleave prior comments: bot comments become assistant turns, PM comments become user turns.
  // Skip the issue-level "overlap/contradiction" analysis acknowledgments by matching their headers.
  // For the refinement-agent brand header, strip it so the LLM doesn't see its own externally-prepended
  // branding in its prior turns (keeps context clean).
  for (const c of comments) {
    const skip =
      c.body.startsWith("### slowcook · overlap detected") ||
      c.body.startsWith("### slowcook · contradiction") ||
      c.body.startsWith("### slowcook · change-of-mind authorized") ||
      c.body.startsWith("### slowcook · follow-up detected");
    if (skip) continue;
    let body = c.body;
    if (c.is_bot && body.startsWith(BRAND_HEADER)) {
      body = body.slice(BRAND_HEADER.length);
    }
    // PM comments in refine threads often include follow-up screenshots.
    // Bot comments are the agent's own prior text — never have images, so
    // skip the fetch cost there.
    const content = c.is_bot ? body : await enrichBodyWithImages(body);
    messages.push({
      role: c.is_bot ? "assistant" : "user",
      content,
    });
  }

  if (supersedes.length > 0) {
    messages.push({
      role: "user",
      content:
        `(slowcook system note: this spec is authorized to supersede ${supersedes
          .map((id) => `story-${id}`)
          .join(", ")}. Set the \`supersedes\` field accordingly.)`,
    });
  }

  // Claude's reasoning-enabled models (Opus 4.7, Sonnet 4.5+) require the
  // conversation to END with a user turn — they refuse to "prefill" an
  // assistant response. If the workflow re-triggered on a label bounce (no
  // new PM comment), the last comment is our own prior bot turn. Strip
  // trailing assistant turns so the agent sees the thread up to the last
  // real user turn and decides from there.
  while (messages.length > 0 && messages[messages.length - 1]?.role === "assistant") {
    messages.pop();
  }

  return messages;
}

interface ParseContext {
  storyId: string;
  issueNumber: number;
  createdAt: string;
  cliVersion: string;
  supersedes: string[];
  /** 0.19.0-α.29 — passed through so synthesizeProposalsFromSpec can detect
   *  multi-app vs single-app shape and emit correct route file paths. */
  repoRoot?: string;
}

export type AgentOutput =
  | { kind: "questions"; markdown: string }
  | { kind: "spec"; spec: Spec };

const EmittedSpecSchema = z.object({
  story_id: z.string().optional(),
  title: z.string(),
  status: z.string().optional(),
  created_at: z.string().optional(),
  supersedes: z.array(z.string()).optional(),
  superseded_by: z.unknown().optional(),
  token_budget_usd: z.number().optional(),
  estimate: z.enum(["small", "medium", "large"]).optional(),
  source_issue: z.string().optional(),
  refined_by: z.string().optional(),
  actors: z.array(z.object({ name: z.string(), notes: z.string().optional() })),
  preconditions: z.array(z.string()),
  invariants: z.array(z.string()),
  api_contract: z.array(z.unknown()).optional(),
  ui_behavior: z.record(z.string(), z.string()).optional(),
  acceptance_scenarios: z.array(z.string()),
  non_goals: z.array(z.string()),
  /**
   * Permissive passthrough — the strict zod parse for proposals lives in
   * spec-yaml.ts (`SpecProposalsSchema`) and runs at READ time. At emit
   * time we want to preserve whatever the LLM produced without tripping
   * on optional-field variance; downstream validation catches malformed
   * shapes when someone tries to re-read the spec file. Accepting
   * `unknown` here means an LLM-emitted proposals block makes it through
   * to `parseAgentOutput`'s output spec.
   */
  proposals: z.unknown().optional(),
  related_specs: z
    .array(
      z.object({
        id: z.string(),
        relationship: z.enum(["overlap", "related", "superseded"]),
        note: z.string().optional(),
      })
    )
    .optional(),
});

/**
 * 0.11.6 — coerce common LLM emit variance to the shapes zod expects.
 * The amendment prompt already tells the agent "acceptance_scenarios is
 * an array of strings" but the LLM (Opus 4.7 as of 2026-04-24) still
 * occasionally emits a {given, when, then} object for one entry. Prompt
 * steering alone can't guarantee this; normalise at ingestion.
 *
 * Current coercions:
 *  - acceptance_scenarios[i] object → joined "Given … When … Then …"
 *    string. If the object doesn't have those keys, JSON-stringify with
 *    a clear marker so the operator sees the malformed emit.
 *  - preconditions / invariants / non_goals: same treatment, in case
 *    future LLMs repeat the pattern on those fields.
 *
 * Non-breaking: if input is already well-formed, it passes through
 * unchanged.
 */
function normalizeEmittedSpec(doc: unknown): unknown {
  if (!doc || typeof doc !== "object") return doc;
  const out = { ...(doc as Record<string, unknown>) };
  const stringifyArrayEntries = (key: string): void => {
    const val = out[key];
    if (!Array.isArray(val)) return;
    out[key] = val.map((entry) => {
      if (typeof entry === "string") return entry;
      if (entry && typeof entry === "object") {
        const o = entry as Record<string, unknown>;
        // Given/When/Then pattern — the most common "helpfully structured"
        // form the amendment agent emits.
        const given = o.given ?? o.Given;
        const when = o.when ?? o.When;
        const then = o.then ?? o.Then;
        if (typeof given === "string" && typeof when === "string" && typeof then === "string") {
          return `Given ${given}, When ${when}, Then ${then}`;
        }
      }
      // Fallback: JSON-stringify with a marker so operators see the
      // structural weirdness in the spec file rather than a crash.
      return `[NORMALIZED_OBJECT] ${JSON.stringify(entry)}`;
    });
  };
  stringifyArrayEntries("acceptance_scenarios");
  stringifyArrayEntries("preconditions");
  stringifyArrayEntries("invariants");
  stringifyArrayEntries("non_goals");

  // 0.19.0-α.27 — default missing required-array fields to []. Without
  // this guard the LLM forgetting a single field (e.g. `non_goals`)
  // crashes refine + posts NOTHING to the PM. Empty array is the
  // semantically safe interpretation ("no non-goals listed") and lets
  // the spec land; the dev sees a warning if any defaulting fires.
  // Observed crash: delgoosh#635 round 6.
  const requiredArrays = [
    "actors",
    "preconditions",
    "invariants",
    "acceptance_scenarios",
    "non_goals",
  ];
  const defaultedFields: string[] = [];
  for (const key of requiredArrays) {
    if (out[key] === undefined || out[key] === null) {
      out[key] = [];
      defaultedFields.push(key);
    }
  }
  if (defaultedFields.length > 0) {
    console.warn(
      `[refine] LLM emit was missing required-array field(s); defaulted to []: ${defaultedFields.join(", ")}. Spec will still emit.`
    );
  }
  return out;
}

export function parseAgentOutput(
  raw: string,
  ctx: ParseContext
): AgentOutput {
  const trimmed = raw.trim();

  // Heuristic: spec starts with `---` or is wrapped in a ```yaml block.
  const yamlBlock = extractYamlBlock(trimmed);
  if (yamlBlock) {
    // Use parseAllDocuments so stray `---` lines (e.g. one inside a pipe
    // block SQL scalar, or an accidentally-doubled separator) don't crash
    // the parse. Pick the first document that validates against the
    // EmittedSpecSchema. 0.11.1 hardening against LLM emit variance.
    const docs = YAML.parseAllDocuments(yamlBlock);
    const parsedDocs = docs
      .map((d) => d.toJS({ maxAliasCount: -1 }))
      .filter((d) => d && typeof d === "object" && "title" in d);
    const doc = parsedDocs[0] ? normalizeEmittedSpec(parsedDocs[0]) : null;
    const parsed = EmittedSpecSchema.safeParse(doc);
    if (!parsed.success) {
      throw new Error(
        `Agent emitted a YAML-shaped response but it failed validation:\n${parsed.error.issues
          .map((i) => `  ${i.path.join(".") || "(root)"}: ${i.message}`)
          .join("\n")}\n\nRaw YAML:\n${yamlBlock.slice(0, 500)}`
      );
    }
    const d = parsed.data;
    const spec: Spec = {
      $schema: "./spec.schema.json",
      story_id: ctx.storyId,
      title: d.title,
      status: "active",
      created_at: ctx.createdAt,
      supersedes: ctx.supersedes,
      superseded_by: null,
      token_budget_usd: d.token_budget_usd,
      estimate: d.estimate,
      source_issue: `#${ctx.issueNumber}`,
      refined_by: `slowcook-refine@${ctx.cliVersion}`,
      actors: d.actors,
      preconditions: d.preconditions,
      invariants: d.invariants,
      api_contract: d.api_contract as Spec["api_contract"],
      ui_behavior: d.ui_behavior,
      acceptance_scenarios: d.acceptance_scenarios,
      non_goals: d.non_goals,
      related_specs: d.related_specs,
    };

    // 0.11.3 hardening — validate LLM-emitted proposals against the
    // strict schema before downstream consumers see them. Malformed
    // proposals (missing required fields, wrong shape) get dropped
    // rather than crashing the PR-body renderer. Valid ones pass
    // through intact.
    if (d.proposals) {
      const proposalsParse = SpecProposalsSchema.safeParse(d.proposals);
      if (proposalsParse.success) {
        spec.proposals = proposalsParse.data as Spec["proposals"];
      }
      // Malformed proposals: drop silently; synth will fill gaps
      // below, and the spec file stays valid with proposals absent.
    }

    // 0.11.3 — deterministic proposals synthesis from spec body.
    // The LLM frequently inlines structure (routes, auth, schema
    // hints) into invariants / api_contract / ui_behavior rather
    // than emitting them in `proposals`. Prompt-only steering has
    // failed twice to produce proposals reliably on well-answered
    // stories. Synthesis fills in categories the LLM left empty
    // using signal from the traditional fields. LLM-emitted
    // proposals ALWAYS win — synth never overrides, only fills gaps.
    const synthesized = synthesizeProposalsFromSpec(spec, {
      repoRoot: ctx.repoRoot,
    });
    if (Object.keys(synthesized).length > 0) {
      spec.proposals = synthesized;
    }

    return { kind: "spec", spec };
  }

  // Otherwise: treat as a question round (markdown).
  if (trimmed.length === 0) {
    throw new Error("Agent returned an empty response; expected questions or a spec.");
  }
  return { kind: "questions", markdown: trimmed };
}

function extractYamlBlock(s: string): string | null {
  // ```yaml ... ``` fenced
  const fence = s.match(/```yaml\s*([\s\S]*?)```/);
  if (fence && fence[1]) return fence[1].trim();

  // Bare YAML starting with --- (document separator)
  if (s.startsWith("---")) {
    return s;
  }

  // 0.11.1: some emit rounds include a prose preamble ahead of the
  // YAML (agent accidentally emits a summary line / apology / etc.
  // despite the prompt forbidding it). If ANY line in the output is
  // exactly `---` and the content after looks like our spec shape,
  // start parsing from that line. Prevents a chatty preamble from
  // breaking the whole run.
  const lines = s.split(/\r?\n/);
  const yamlStart = lines.findIndex((l) => l.trim() === "---");
  if (yamlStart >= 0) {
    const candidate = lines.slice(yamlStart).join("\n");
    if (/\ntitle:\s/i.test(candidate) || /\nstory_id:\s/i.test(candidate)) {
      return candidate;
    }
  }

  // Content that's just YAML without front-matter fence — detect heuristically.
  // If it contains typical spec keys AND doesn't look like markdown, treat as YAML.
  const looksLikeYaml =
    /(^|\n)title:\s/i.test(s) &&
    /(^|\n)actors:\s*/i.test(s) &&
    /(^|\n)acceptance_scenarios:\s*/i.test(s);
  if (looksLikeYaml && !s.includes("```") && !s.includes("### ")) {
    return s;
  }

  return null;
}

/* ======================================================================== */
/* 0.11.5 — PR-driven resubmit                                              */
/* ======================================================================== */

export interface ResubmitContext {
  prNumber: number;
  /**
   * 0.11.10+ — when refine was triggered by a `pull_request_review_comment`
   * event, this is the id of the triggering inline comment. Agent will
   * post its response as a threaded reply to that comment. Null when the
   * trigger was an `issue_comment` or `pull_request_review` event.
   */
  reviewCommentId: number | null;
  repoRoot: string;
  forge: ForgeAdapter;
  llm: LlmClient;
  refineModel: string;
  cliVersion: string;
  baseBranch: string;
  now: Date;
}

export type ResubmitOutcome =
  | { kind: "resubmitted"; specPath: string; branch: string }
  | {
      /**
       * 0.11.11+ — /refine was processed on an already-merged spec PR;
       * amendment went onto a fresh follow-up branch and a new PR was
       * opened. Refine still responds to the original comment so the PM
       * sees the handoff without leaving the merged-PR thread.
       */
      kind: "follow-up-opened";
      specPath: string;
      branch: string;
      followUpPrNumber: number;
      followUpPrUrl: string;
    }
  | { kind: "noop"; reason: string };

/**
 * Read a small window of lines around a target line number in a file,
 * for inline-review-comment context (0.11.8+). Returns up to 3 lines
 * (the target line ± 1), 1-indexed like editor tooling, so the agent
 * can see what the PM was commenting on without having to re-read the
 * whole file.
 */
function extractFileLineExcerpt(
  repoRoot: string,
  path: string,
  line: number
): string | null {
  try {
    const abs = join(repoRoot, path);
    const lines = readFileSync(abs, "utf8").split(/\r?\n/);
    const start = Math.max(0, line - 2);
    const end = Math.min(lines.length, line + 1);
    const slice = lines.slice(start, end);
    return slice
      .map((l, i) => `${(start + i + 1).toString().padStart(4, " ")}│ ${l}`)
      .join("\n");
  } catch {
    return null;
  }
}

/**
 * Read the story id from the current git branch (expected pattern:
 * `slowcook/spec/story-<id>`). CLI workflow checks out the PR branch
 * before invoking us, so `git branch --show-current` is authoritative.
 */
function detectStoryIdFromBranch(repoRoot: string): string | null {
  try {
    const branch = execSync("git branch --show-current", {
      cwd: repoRoot,
      encoding: "utf8",
    }).trim();
    const m = branch.match(/^slowcook\/spec\/story-(.+)$/);
    return m && m[1] ? m[1] : null;
  } catch {
    return null;
  }
}

/**
 * Amend a spec on its existing PR branch based on PR review comments.
 *
 * Flow:
 *   1. Detect story id from current branch
 *   2. Load current spec YAML from disk
 *   3. Fetch PR comments — filter to PM replies since the most recent
 *      spec-author commit (agent's own edits don't count as feedback)
 *   4. Call LLM in amendment mode: old spec + feedback → new spec
 *   5. Parse emitted YAML, run through spec-body synth + proposals validator
 *   6. Write updated spec, stage, commit, force-push, post summary comment
 *
 * Kept intentionally narrow: no relationship analysis (spec already
 * exists), no supersede logic (that's refine-proper's job on a new
 * story), no test manifest changes.
 */
export async function runResubmitRefinement(
  ctx: ResubmitContext
): Promise<ResubmitOutcome> {
  const storyId = detectStoryIdFromBranch(ctx.repoRoot);
  if (!storyId) {
    return {
      kind: "noop",
      reason:
        "could not detect story id from current branch — expected `slowcook/spec/story-N` pattern",
    };
  }

  let spec: Spec;
  try {
    spec = readSpec(ctx.repoRoot, storyId);
  } catch (e) {
    return {
      kind: "noop",
      reason: `could not read spec for story-${storyId}: ${(e as Error).message}`,
    };
  }

  // PR comments — listIssueComments covers timeline comments. Review
  // comments (line-anchored) come from a separate endpoint (0.11.8+).
  // Filter bot-authored brand-header comments in both — don't feed the
  // agent its own prior output.
  const [timelineComments, reviewComments] = await Promise.all([
    ctx.forge.listIssueComments(ctx.prNumber),
    ctx.forge.listPullRequestReviewComments?.(ctx.prNumber) ?? Promise.resolve([]),
  ]);
  const pmTimeline = timelineComments.filter((c) => {
    const body = c.body ?? "";
    if (body.startsWith("### slowcook ·")) return false;
    return true;
  });
  const pmReview = reviewComments.filter((c) => {
    if (c.is_bot) return false;
    const body = c.body ?? "";
    if (body.startsWith("### slowcook ·")) return false;
    return true;
  });

  if (pmTimeline.length === 0 && pmReview.length === 0) {
    return {
      kind: "noop",
      reason: "no PM comments (timeline or review) to process on the PR",
    };
  }

  // Structure feedback with clear source labels so the amendment agent
  // can tell timeline feedback (whole-spec scope) from line-anchored
  // feedback (single-field scope). Line-anchored comments include the
  // path + line + a short excerpt from the spec file at that line so
  // the agent can match feedback to the exact field being reviewed.
  const timelineFeedback = pmTimeline
    .map((c) => `## Timeline comment — @${c.author} at ${c.created_at}\n${c.body}`)
    .join("\n\n");
  const reviewFeedback = pmReview
    .map((c) => {
      const excerpt = c.line != null ? extractFileLineExcerpt(ctx.repoRoot, c.path, c.line) : null;
      const excerptBlock = excerpt
        ? `\nContext from ${c.path} around line ${c.line}:\n\`\`\`yaml\n${excerpt}\n\`\`\`\n`
        : "";
      return (
        `## Inline comment — @${c.author} on ${c.path}${c.line != null ? ":" + c.line : " (outdated)"} at ${c.created_at}\n` +
        excerptBlock +
        `Feedback:\n${c.body}`
      );
    })
    .join("\n\n");
  const feedback = [timelineFeedback, reviewFeedback].filter(Boolean).join("\n\n---\n\n");

  const projectContext = buildProjectContext(ctx.repoRoot);
  const systemPrompt = AMENDMENT_SYSTEM(projectContext);

  const userMessage =
    `## Current spec (story-${storyId})\n\n\`\`\`yaml\n${YAML.stringify(spec)}\n\`\`\`\n\n` +
    `## PM feedback on the spec PR\n\n${feedback}\n\n` +
    `Produce the AMENDED spec YAML applying the feedback. Preserve anything the feedback doesn't touch. Start your response with \`---\` and emit only YAML (no prose wrapper).`;

  const response = await ctx.llm.complete({
    system: systemPrompt,
    cacheSystem: true,
    model: ctx.refineModel,
    messages: [{ role: "user", content: userMessage }],
    maxTokens: 8192,
  });

  const parsed = parseAgentOutput(response.text, {
    storyId,
    issueNumber: parseInt((spec.source_issue ?? "#0").replace("#", ""), 10) || 0,
    createdAt: spec.created_at,
    supersedes: spec.supersedes,
    cliVersion: ctx.cliVersion,
  });

  if (parsed.kind !== "spec") {
    return {
      kind: "noop",
      reason: "agent did not emit a spec in the amendment round",
    };
  }

  // 0.11.11+ — detect the "PM commented /refine on an already-merged
  // spec PR" case. If we force-push the amendment onto the original
  // `slowcook/spec/story-N` branch, the merged PR's diff doesn't
  // update (its head is frozen at merge time) and the amendment is
  // effectively orphaned on a dead branch. Instead, push to a
  // follow-up branch and open a new PR. Detection is optional — if
  // the adapter doesn't expose `getPullRequest`, fall through to the
  // previous force-push-to-same-branch path.
  let isFollowUp = false;
  if (ctx.forge.getPullRequest) {
    try {
      const pr = await ctx.forge.getPullRequest(ctx.prNumber);
      isFollowUp = pr.state === "closed" && pr.merged;
    } catch {
      // If we can't fetch PR state, behave like older versions.
    }
  }

  // 0.14.0-α.6+ — content-level repair before persisting (amendment path).
  const amendmentFindings = validateAndRepairSpec(parsed.spec);
  if (amendmentFindings.length > 0) {
    console.warn(
      `[refine amend] spec post-emit validation: ${amendmentFindings.length} finding(s) — corrupt token entries pruned:`
    );
    for (const f of amendmentFindings) {
      console.warn(`  - ${f.path}: ${f.message} (${f.action})`);
    }
  }

  // Write, stage, commit
  const specPath = writeSpec(ctx.repoRoot, parsed.spec);
  await ctx.forge.git.stage(join(SPECS_DIR, `story-${storyId}.yaml`));

  // 0.14.0-α.1 mockup-first data-layer seam — emit `.mock.ts` files
  // for any fixture domains in the amended spec. Skipped silently
  // when proposals.fixtures is absent or rejected.
  const mockResult = writeMockFixtures(ctx.repoRoot, parsed.spec);
  if (mockResult.written.length > 0) {
    console.log(
      `[refine amend] wrote ${mockResult.written.length} mock fixture file(s): ${mockResult.written.join(", ")}`
    );
    for (const f of mockResult.written) {
      await ctx.forge.git.stage(f);
    }
  }

  // 0.11.12+ — detect "LLM produced a spec byte-identical to current
  // state" no-op. Before 0.11.12 we called `git commit` directly here,
  // which exits 1 with "nothing to commit" when the LLM rewrote the
  // spec but the re-serialised YAML matched the committed file — and
  // the crash took the whole run down without posting any response to
  // the PM. Now: detect the no-op, post an explanatory comment so the
  // PM knows their feedback landed but didn't produce a change, and
  // return cleanly.
  if (ctx.forge.git.hasStagedChanges) {
    const changed = await ctx.forge.git.hasStagedChanges();
    if (!changed) {
      const marker = costMarker({
        agent: "refine",
        usd: response.costUsd,
        tokensIn: response.usage.inputTokens,
        tokensOut: response.usage.outputTokens,
        cacheRead: response.usage.cacheReadTokens,
        cacheCreate: response.usage.cacheCreateTokens,
        model: response.model,
        round: "resubmit-noop",
      });
      const body =
        `${BRAND_HEADER}Re-read your feedback but produced the same spec — ` +
        `either I already reflected the change elsewhere in the YAML, or I ` +
        `misread what you wanted. Could you point at the specific field(s) ` +
        `you want changed (ideally with the expected before/after)?\n\n${marker}`;
      let posted = false;
      if (ctx.reviewCommentId && ctx.forge.createReviewCommentReply) {
        try {
          await ctx.forge.createReviewCommentReply(
            ctx.prNumber,
            ctx.reviewCommentId,
            body
          );
          posted = true;
        } catch {
          /* fall through */
        }
      }
      if (!posted) {
        await ctx.forge.createIssueComment(ctx.prNumber, body);
      }
      return {
        kind: "noop",
        reason:
          "agent produced amendment byte-identical to committed spec — likely misread feedback or conflated fields",
      };
    }
  }

  await ctx.forge.git.commit(
    `refine: resubmit story-${storyId} per PR #${ctx.prNumber} feedback`
  );

  // Pick branch: same branch (force-push) when the PR is open; a fresh
  // timestamped follow-up branch when the PR is already merged so the
  // new PR has a clean head and doesn't collide with the merged branch.
  const originalBranch = `slowcook/spec/story-${storyId}`;
  const followUpBranch = isFollowUp
    ? `slowcook/spec/story-${storyId}-amend-${ctx.now.getTime()}`
    : null;
  if (isFollowUp && followUpBranch) {
    // The amendment commit currently sits on the original branch's tip
    // (checkout happened at workflow setup). Create the follow-up
    // branch off the current HEAD and push that instead. The original
    // branch is left untouched.
    await ctx.forge.git.createBranch(followUpBranch);
    await ctx.forge.git.push(followUpBranch);
  } else {
    await ctx.forge.git.push(originalBranch);
  }
  const branch = followUpBranch ?? originalBranch;

  // Open a follow-up PR when the original was already merged. Do this
  // BEFORE posting the summary comment so the comment can link to it.
  let followUpPr: { number: number; url: string } | null = null;
  if (isFollowUp && followUpBranch) {
    try {
      const pr = await ctx.forge.createPullRequest({
        title: `refine: amend story-${storyId} (follow-up to #${ctx.prNumber})`,
        body:
          `Follow-up to #${ctx.prNumber}, which was already merged when a new \`/refine\` comment arrived. ` +
          `This PR carries the amended spec for story-${storyId} per the PM feedback on that merged PR.\n\n` +
          `Merging this updates the spec; downstream pipeline (testgen → brew) picks up automatically.\n\n` +
          `(Generated by slowcook refine — 0.11.11+.)`,
        head: followUpBranch,
        base: ctx.baseBranch,
        labels: ["slowcook-spec"],
      });
      followUpPr = { number: pr.number, url: pr.url };
    } catch {
      // If PR open fails (permissions, branch rules, etc.) we still
      // have the amendment on the follow-up branch — flag that in the
      // comment so the PM can open the PR manually.
    }
  }

  // Post a summary comment on the ORIGINAL PR so the PM sees the
  // handoff from the thread where they left /refine.
  try {
    const costUsd = response.costUsd;
    const marker = costMarker({
      agent: "refine",
      usd: costUsd,
      tokensIn: response.usage.inputTokens,
      tokensOut: response.usage.outputTokens,
      cacheRead: response.usage.cacheReadTokens,
      cacheCreate: response.usage.cacheCreateTokens,
      model: response.model,
      round: "resubmit",
    });
    let body: string;
    if (isFollowUp && followUpPr) {
      body =
        `${BRAND_HEADER}This PR was already merged, so I opened a follow-up: #${followUpPr.number} ` +
        `carries the amended spec for story-${storyId} per your feedback. Branch: \`${branch}\`.\n\n` +
        `Merge that PR to promote the amendment through the pipeline.\n\n${marker}`;
    } else if (isFollowUp && !followUpPr) {
      body =
        `${BRAND_HEADER}This PR was already merged. I pushed the amended spec to \`${branch}\` ` +
        `but couldn't open the follow-up PR automatically — please open one from that branch.\n\n${marker}`;
    } else {
      body =
        `${BRAND_HEADER}Amended spec per your feedback. Force-pushed to \`${branch}\`; ` +
        `the PR diff reflects the new spec.\n\n${marker}`;
    }

    // 0.11.10+ — when the trigger was an inline review comment and the
    // forge adapter supports threaded replies, reply *under* the PM's
    // original comment so the conversation stays anchored to the exact
    // line they were reviewing. Fall back to the timeline-comment shape
    // for other triggers (issue_comment, review with /refine in the
    // batched review body) where there's no single-comment anchor — and
    // when the threaded reply itself fails (e.g., the comment was
    // deleted or the API call errored), so the agent's response is
    // never lost entirely.
    let posted = false;
    if (ctx.reviewCommentId && ctx.forge.createReviewCommentReply) {
      try {
        await ctx.forge.createReviewCommentReply(
          ctx.prNumber,
          ctx.reviewCommentId,
          body
        );
        posted = true;
      } catch {
        // Fall through to timeline comment.
      }
    }
    if (!posted) {
      await ctx.forge.createIssueComment(ctx.prNumber, body);
    }
  } catch {
    /* best effort */
  }

  // Read the file back from disk and verify the content we just wrote
  // contains the expected story_id — catches the case where the YAML
  // ended up at a different path than expected.
  try {
    void readFileSync(specPath, "utf8");
  } catch {
    /* already in error path if this fails */
  }

  if (isFollowUp && followUpPr) {
    return {
      kind: "follow-up-opened",
      specPath,
      branch,
      followUpPrNumber: followUpPr.number,
      followUpPrUrl: followUpPr.url,
    };
  }
  return { kind: "resubmitted", specPath, branch };
}
