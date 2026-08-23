/**
 * Plate agent — mockup-amendment loop (0.15.0-α.3).
 *
 * Single-shot LLM call per `/plate` trigger. Reads PR comments + image
 * attachments since the last plate commit, amends mockup files with
 * minimum diff, returns the parsed result for the index.ts wrapper to
 * write + force-push.
 *
 * Same shape as vibe's agent but accepts vision-message inputs (image
 * blocks alongside text). No format-compliance retry — plate is mid-
 * iteration; if the model emits prose-only on round 1, the calling
 * dispatch surfaces the problem to the PM via a comment ("plate
 * couldn't parse a response — re-run with `/plate` to retry").
 */

import type { LlmClient } from "@slowcook-ai/core";
import {
  PLATE_AMENDMENT_SYSTEM,
  buildPlateAmendmentPrompt,
  type PlateFeedback,
} from "./prompts.js";
import {
  parseVibeOutput,
  type VibeChangeRequest,
  type VibeFileBlock,
} from "../vibe/emit.js";

const MAX_TOKENS = 8192;

export interface PlateContext {
  repoRoot: string;
  llm: LlmClient;
  model: string;
  storyId: string;
  prNumber: number;
  cliVersion: string;
  /** Pre-rendered project-context blob (same shape as vibe). */
  projectContext: string;
  /** Spec YAML, for context only. */
  specYaml: string;
  /** Current state of mockup files on the branch. */
  currentFiles: Array<{ path: string; contents: string }>;
  /** PM feedback to act on. */
  feedback: PlateFeedback;
  /**
   * Mock shape — read from `.brewing/mock.yaml` (sc#82). Defaults to
   * `nextjs` for backwards-compat with consumers that predate sc#82.
   * Branches navigation primitives + scenario imports in the system
   * prompt.
   */
  mockShape?: "vite" | "nextjs";
}

export type PlateResult =
  | {
      kind: "amended";
      files: VibeFileBlock[];
      changeRequests: VibeChangeRequest[];
      summary: string;
      spendUsd: number;
    }
  | {
      kind: "no-op";
      summary: string;
      spendUsd: number;
    }
  | {
      kind: "format-failure";
      finalText: string;
      spendUsd: number;
    };

/** Extract the optional `<plate_summary>` block. */
function parsePlateSummary(body: string): string | null {
  const m = body.match(/<plate_summary>([\s\S]*?)<\/plate_summary>/);
  return m ? m[1]!.trim() : null;
}

export async function runPlate(ctx: PlateContext): Promise<PlateResult> {
  const llm = ctx.llm;

  const userBlocks = buildPlateAmendmentPrompt({
    storyId: ctx.storyId,
    prNumber: ctx.prNumber,
    specYaml: ctx.specYaml,
    currentFiles: ctx.currentFiles,
    feedback: ctx.feedback,
  });

  const response = await llm.complete({
    model: ctx.model,
    maxTokens: MAX_TOKENS,
    system: PLATE_AMENDMENT_SYSTEM(ctx.projectContext, ctx.mockShape ?? "nextjs"),
    messages: [{ role: "user", content: userBlocks as never }],
    stream: true,
  });

  const spendUsd = response.costUsd;
  const finalText = response.text;

  const parsed = parseVibeOutput(finalText);
  const summary = parsePlateSummary(finalText) ?? "";

  // No-op case: summary present but no file blocks. Plate explicitly
  // chose not to amend (because feedback was answered by existing state,
  // or it surfaced a clarifying question). We still post the summary.
  if (parsed.files.length === 0) {
    if (summary) {
      return { kind: "no-op", summary, spendUsd };
    }
    return { kind: "format-failure", finalText, spendUsd };
  }

  return {
    kind: "amended",
    files: parsed.files,
    changeRequests: parsed.changeRequests,
    summary: summary || "(no summary block emitted)",
    spendUsd,
  };
}



export { parsePlateSummary };
