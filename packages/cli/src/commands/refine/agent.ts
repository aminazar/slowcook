import YAML from "yaml";
import { z } from "zod";
import type { LlmClient, LlmMessage } from "./llm.js";
import { costMarker } from "./llm.js";
import { synthesizeProposalsFromSpec } from "./proposals-synth.js";
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
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildProjectContext } from "./context.js";
import {
  analyzeRelationship,
  contradictionCommentBody,
  overlapCommentBody,
  followUpCommentBody,
} from "./relationship.js";
import { applySupersede } from "@slowcook-ai/core";

export const LABEL_CHANGE_OF_MIND = "change-of-mind";
export const LABEL_BLOCKED_CONTRADICTION = "blocked-contradiction";
export const LABEL_BLOCKED_OVERLAP = "blocked-overlap";
export const LABEL_SPEC_SUBMITTED = "spec-submitted";
export const LABEL_SPEC_READY = "spec-ready";
export const LABEL_NEEDS_REFINEMENT = "needs-refinement";

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

  // Step 1: relationship analysis
  const existingSpecs = listActiveSpecs(ctx.repoRoot);
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
      const marker = costMarker({
        agent: "refine",
        usd: roundCostUsd,
        tokensIn: totalTokensIn,
        tokensOut: totalTokensOut,
        cacheRead: totalCacheRead,
        cacheCreate: totalCacheCreate,
        model: ctx.relationshipModel,
        round: "relationship-contradiction",
      });
      await ctx.forge.createIssueComment(
        ctx.issueNumber,
        contradictionCommentBody(verdict, false, existingSpecs) + "\n\n" + marker
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
  const chat = buildChatHistory(issue, comments, supersedes);
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
  });

  const refineCostMarker = costMarker({
    agent: "refine",
    usd: roundCostUsd,
    tokensIn: totalTokensIn,
    tokensOut: totalTokensOut,
    cacheRead: totalCacheRead,
    cacheCreate: totalCacheCreate,
    model: ctx.refineModel,
    round: parsed.kind === "questions" ? "questions" : "spec",
  });

  if (parsed.kind === "questions") {
    const comment = await ctx.forge.createIssueComment(
      ctx.issueNumber,
      BRAND_HEADER + parsed.markdown + "\n\n" + refineCostMarker
    );
    return { kind: "questions-posted", commentId: comment.id };
  }

  // Spec emitted → write, update index, open draft PR
  const spec = parsed.spec;
  const specPath = writeSpec(ctx.repoRoot, spec);

  const index = readIndex(ctx.repoRoot);
  const updatedIndex = applySupersede(
    index,
    { id: spec.story_id, entry: entryFromSpec(spec) },
    supersedes
  );
  writeIndex(ctx.repoRoot, updatedIndex);

  const branch = `slowcook/spec/story-${spec.story_id}`;
  await ctx.forge.git.createBranch(branch);
  await ctx.forge.git.stage(specPath);
  await ctx.forge.git.stage(`specs/_index.yaml`);
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
      await ctx.forge.createIssueComment(
        ctx.issueNumber,
        `### slowcook · spec submitted\n\n` +
          `Spec \`story-${spec.story_id}\` opened at [PR #${pr.number}](${pr.url}). Merge to trigger \`slowcook-testgen\`.\n\n` +
          refineCostMarker
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

function buildChatHistory(
  issue: Issue,
  comments: Comment[],
  supersedes: string[]
): LlmMessage[] {
  // First message: the issue body + metadata.
  const issueBlock = `# Issue #${issue.number}: ${issue.title}

${issue.body}`;

  const messages: LlmMessage[] = [{ role: "user", content: issueBlock }];

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
    messages.push({
      role: c.is_bot ? "assistant" : "user",
      content: body,
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
    const synthesized = synthesizeProposalsFromSpec(spec);
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
  | { kind: "noop"; reason: string };

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

  // PR comments — listIssueComments covers PR timeline comments. We
  // want PM feedback only; filter out bot-authored agent brand-header
  // comments so we don't feed the agent its own prior output.
  const comments = await ctx.forge.listIssueComments(ctx.prNumber);
  const pmComments = comments.filter((c) => {
    const body = c.body ?? "";
    if (body.startsWith("### slowcook ·")) return false;
    return true;
  });

  if (pmComments.length === 0) {
    return {
      kind: "noop",
      reason: "no PM comments to process on the PR",
    };
  }

  const feedback = pmComments
    .map((c) => `— @${c.author} at ${c.created_at}:\n${c.body}`)
    .join("\n\n---\n\n");

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

  // Write, stage, commit, force-push
  const specPath = writeSpec(ctx.repoRoot, parsed.spec);
  await ctx.forge.git.stage(join(SPECS_DIR, `story-${storyId}.yaml`));
  await ctx.forge.git.commit(
    `refine: resubmit story-${storyId} per PR #${ctx.prNumber} feedback`
  );
  const branch = `slowcook/spec/story-${storyId}`;
  await ctx.forge.git.push(branch);

  // Post a summary comment on the PR
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
    const body =
      `${BRAND_HEADER}Amended spec per your feedback. Force-pushed to \`${branch}\`; ` +
      `the PR diff reflects the new spec.\n\n${marker}`;
    await ctx.forge.createIssueComment(ctx.prNumber, body);
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

  return { kind: "resubmitted", specPath, branch };
}
