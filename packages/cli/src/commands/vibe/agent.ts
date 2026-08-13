/**
 * Vibe agent — single-shot mockup generator (0.15.0-α.1).
 *
 * Reads spec.yaml + brownfield extracts + code-map summary, calls the
 * LLM once with the VIBE_SYSTEM prompt, parses the XML-block output,
 * writes files + collects component-change requests.
 *
 * Pattern mirrors investigate/agent.ts but simpler:
 *  - no tools (vibe doesn't read files; the project context is inlined)
 *  - single LLM call (multi-round iteration belongs to plate, not vibe)
 *  - format-compliance retry once if the agent emits prose
 *
 * Returns a `VibeResult` the index.ts dispatch consumes for git ops +
 * PR opening.
 */

import Anthropic from "@anthropic-ai/sdk";
import {
  VIBE_SYSTEM,
  buildVibeUserPrompt,
} from "./prompts.js";
import {
  parseVibeOutput,
  writeVibeFiles,
  type VibeChangeRequest,
  type VibeFileBlock,
} from "./emit.js";
import { costUsdForUsage } from "@slowcook-ai/llm-anthropic";
import { resolveModel } from "../../lib/model-defaults.js";

const DEFAULT_MODEL = resolveModel("vibe");
const MAX_TOKENS = 8192;

export interface VibeContext {
  repoRoot: string;
  anthropicApiKey: string;
  model: string;
  storyId: string;
  cliVersion: string;
  /** Pre-rendered spec YAML (read by the index.ts wrapper). */
  specYaml: string;
  /**
   * Pre-assembled project-context blob: brownfield extracts + code-map
   * summary, formatted as Markdown. The index.ts wrapper builds this
   * from `.brewing/diagrams/{schema.mmd, tokens.md}` + a code-map
   * digest.
   */
  projectContext: string;
  /** Optional similar-pages-in-codebase free-form hint. */
  similarPagesHint?: string;
  /**
   * Mock shape — read from `.brewing/mock.yaml` (sc#82). Defaults to
   * `nextjs` for backwards-compat with consumers that predate sc#82.
   * Branches path conventions, scenario imports, and navigation
   * primitives in the system prompt.
   */
  mockShape?: "vite" | "nextjs";
}

export type VibeResult =
  | {
      kind: "emitted";
      files: VibeFileBlock[];
      writtenPaths: string[];
      changeRequests: VibeChangeRequest[];
      spendUsd: number;
      rounds: number;
    }
  | {
      kind: "format-failure";
      finalText: string;
      spendUsd: number;
      rounds: number;
    };

export async function runVibe(ctx: VibeContext): Promise<VibeResult> {
  const anthropic = new Anthropic({ apiKey: ctx.anthropicApiKey });

  const userPrompt = buildVibeUserPrompt({
    storyId: ctx.storyId,
    specYaml: ctx.specYaml,
    similarPagesHint: ctx.similarPagesHint,
  });

  const messages: Anthropic.Messages.MessageParam[] = [
    { role: "user", content: userPrompt },
  ];

  let spendUsd = 0;
  let rounds = 0;
  let finalText = "";

  // Round 1 — fresh emit.
  rounds += 1;
  const r1 = await anthropic.messages.create({
    model: ctx.model,
    max_tokens: MAX_TOKENS,
    system: VIBE_SYSTEM(ctx.projectContext, ctx.mockShape ?? "nextjs"),
    messages,
  });
  spendUsd += costUsd(r1, ctx.model);
  for (const block of r1.content) {
    if (block.type === "text") finalText = block.text;
  }

  // Format-compliance retry (single nudge) if no <file> blocks parsed.
  // Mirrors investigate's pattern from 0.13.0-alpha.2c.
  let parsed = parseVibeOutput(finalText);
  if (parsed.files.length === 0) {
    rounds += 1;
    messages.push({ role: "assistant", content: finalText });
    messages.push({
      role: "user",
      content:
        "Your previous reply contained no `<file path=\"...\">...</file>` blocks. Slowcook's parser greps for those literal tags. Re-emit now using the Output format from your system prompt: each file as a separate `<file path=\"...\">contents</file>` block. No prose preamble or postscript.",
    });
    const r2 = await anthropic.messages.create({
      model: ctx.model,
      max_tokens: MAX_TOKENS,
      system: VIBE_SYSTEM(ctx.projectContext, ctx.mockShape ?? "nextjs"),
      messages,
    });
    spendUsd += costUsd(r2, ctx.model);
    for (const block of r2.content) {
      if (block.type === "text") finalText = block.text;
    }
    parsed = parseVibeOutput(finalText);
  }

  if (parsed.files.length === 0) {
    return {
      kind: "format-failure",
      finalText,
      spendUsd,
      rounds,
    };
  }

  const writtenPaths = writeVibeFiles(ctx.repoRoot, parsed.files);
  return {
    kind: "emitted",
    files: parsed.files,
    writtenPaths,
    changeRequests: parsed.changeRequests,
    spendUsd,
    rounds,
  };
}

function costUsd(response: Anthropic.Messages.Message, model: string): number {
  const usage = response.usage as Anthropic.Messages.Usage & {
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
  return costUsdForUsage(model, {
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    cacheReadTokens: usage.cache_read_input_tokens ?? 0,
    cacheCreateTokens: usage.cache_creation_input_tokens ?? 0,
  });
}
