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

import type { LlmClient, LlmMessage } from "@slowcook-ai/core";
import {
  VIBE_SYSTEM,
  buildVibeUserPrompt,
} from "./prompts.js";
import {
  parseVibeOutput,
  writeVibeFiles,
  buildMockCheck,
  type VibeChangeRequest,
  type VibeFileBlock,
} from "./emit.js";
import { resolveModel } from "../../lib/model-defaults.js";

const DEFAULT_MODEL = resolveModel("vibe");
const MAX_TOKENS = 8192;

export interface VibeContext {
  repoRoot: string;
  /** Backend-agnostic LLM client (2026-08-23) — vibe is text-only and
   * always could have run on the CLI subscription; now it does. */
  llm: LlmClient;
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
  /** Mock root dir from mock.yaml (default "mock") — build-check cwd. */
  mockRoot?: string;
  /** Tests inject true; the build check needs a real toolchain. */
  skipBuildCheck?: boolean;
}

export type VibeResult =
  | {
      kind: "build-failure";
      errors: string;
      finalText: string;
      spendUsd: number;
      rounds: number;
    }
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
  const llm = ctx.llm;

  const userPrompt = buildVibeUserPrompt({
    storyId: ctx.storyId,
    specYaml: ctx.specYaml,
    similarPagesHint: ctx.similarPagesHint,
  });

  const messages: LlmMessage[] = [{ role: "user", content: userPrompt }];

  let spendUsd = 0;
  let rounds = 0;
  let finalText = "";

  // Round 1 — fresh emit.
  rounds += 1;
  const r1 = await llm.complete({
    model: ctx.model,
    maxTokens: MAX_TOKENS,
    system: VIBE_SYSTEM(ctx.projectContext, ctx.mockShape ?? "nextjs"),
    messages,
    stream: true,
  });
  spendUsd += r1.costUsd;
  if (r1.text) finalText = r1.text;

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
    const r2 = await llm.complete({
      model: ctx.model,
      maxTokens: MAX_TOKENS,
      system: VIBE_SYSTEM(ctx.projectContext, ctx.mockShape ?? "nextjs"),
      messages,
      stream: true,
    });
    spendUsd += r2.costUsd;
    if (r2.text) finalText = r2.text;
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

  let writtenPaths = writeVibeFiles(ctx.repoRoot, parsed.files);

  // 2026-08-24 (#501) — a mockup that does not BUILD is not a reviewable
  // artifact (story-016 shipped a dead entry file + unmounted overlay; a
  // human hand-wired it). One build check, one repair round, then fail
  // loudly rather than open a broken PR.
  if (!ctx.skipBuildCheck) {
    let check = buildMockCheck(ctx.repoRoot, ctx.mockRoot ?? "mock", ctx.mockShape ?? "vite");
    if (check.skipped) {
      console.log(`  build-check skipped: ${check.skipped}`);
    } else if (!check.ok) {
      console.log(`  mock build FAILED — one repair round…`);
      rounds += 1;
      const repair = await ctx.llm.complete({
        model: ctx.model,
        maxTokens: 32_000,
        system: VIBE_SYSTEM(ctx.projectContext, ctx.mockShape ?? "nextjs"),
        messages: [
          { role: "user", content: userPrompt },
          { role: "assistant", content: finalText },
          {
            role: "user",
            content:
              `The emitted mockup does NOT build. Build errors:\n\n${check.errors}\n\n` +
              `Re-emit ONLY the files that need to change (same <file path=...> format), fixing every error. ` +
              `Remember the entry file must actually mount the app and the overlay — dead files that merely parse are not a mockup.`,
          },
        ],
        stream: true,
      });
      spendUsd += repair.costUsd;
      const reparsed = parseVibeOutput(repair.text);
      if (reparsed.files.length > 0) {
        const repairedPaths = writeVibeFiles(ctx.repoRoot, reparsed.files);
        writtenPaths = Array.from(new Set([...writtenPaths, ...repairedPaths]));
        const merged = new Map(parsed.files.map((f) => [f.path, f]));
        for (const f of reparsed.files) merged.set(f.path, f);
        parsed = { ...parsed, files: [...merged.values()] };
      }
      check = buildMockCheck(ctx.repoRoot, ctx.mockRoot ?? "mock", ctx.mockShape ?? "vite");
      if (!check.ok) {
        return {
          kind: "build-failure",
          errors: check.errors ?? "(no detail)",
          finalText,
          spendUsd,
          rounds,
        };
      }
      console.log(`  mock builds after repair.`);
    }
  }

  return {
    kind: "emitted",
    files: parsed.files,
    writtenPaths,
    changeRequests: parsed.changeRequests,
    spendUsd,
    rounds,
  };
}


