/**
 * PERSISTENT-CONVERSATION BREW (#399, the R4a ruling).
 *
 * The design test, from the handover: "why should it re-read everything it
 * already read in iteration 1?" — the model must LEARN from a revert
 * in-context ("your edit was reverted because it broke X") rather than have
 * its memory wiped by it. The ratchet is feedback, not a guillotine.
 *
 * Measured cost of the fresh-context design it replaces: identical read
 * sequences across iterations 1–6; $10.42 uncached input vs $1.23 cache-read
 * in one day; two turns cut at the round cap mid-orientation.
 *
 * This module is the PURE half: message bookkeeping, token estimation,
 * deterministic compaction, lesson framing. agent.ts owns the loop and the
 * API; nothing here touches the SDK, so every rule unit-tests.
 */
import type Anthropic from "@anthropic-ai/sdk";

export type Msg = Anthropic.Messages.MessageParam;

/** chars/4 — deliberately crude; compaction only needs the right order of
 *  magnitude, and a real tokenizer here would drag the SDK into a pure file. */
export function estimateTokens(messages: Msg[]): number {
  let chars = 0;
  for (const m of messages) {
    if (typeof m.content === "string") chars += m.content.length;
    else for (const b of m.content) {
      const t = (b as { text?: string; content?: unknown }).text
        ?? (typeof (b as { content?: unknown }).content === "string" ? (b as { content: string }).content : "");
      chars += String(t ?? "").length + 64;
    }
  }
  return Math.ceil(chars / 4);
}

/**
 * A revert/rejection becomes an in-context LESSON — a user message the next
 * turn can cite without re-reading anything. The wording reuses the §13
 * teaching notes verbatim (they were proven live: the very next iteration
 * called justify_diff_overflow after the taught rejection).
 */
export function lessonMessage(iteration: number, note: string): Msg {
  return {
    role: "user",
    content:
      `LESSON from iteration ${iteration} (this conversation continues — do not re-orient):\n${note}\n` +
      `Apply this directly in your next attempt.`,
  };
}

/**
 * DETERMINISTIC COMPACTION. When the conversation nears the window, truncate
 * the OLDEST tool_result contents to short heads — the reads they carried are
 * stale by now; the assistant's own text (its reasoning + lessons) survives
 * untouched, as does the head message (cached prefix). Never an LLM call:
 * summarizing with the model would spend budget to save budget.
 *
 * Returns how many tool_result blocks were truncated.
 */
export function compactOldToolResults(
  messages: Msg[],
  opts: { keepRecentMessages?: number; headChars?: number } = {}
): number {
  const keep = opts.keepRecentMessages ?? 8;
  const head = opts.headChars ?? 200;
  let truncated = 0;
  const cutoff = Math.max(1, messages.length - keep); // index 0 (head) always intact
  for (let i = 1; i < cutoff; i++) {
    const m = messages[i]!;
    if (m.role !== "user" || typeof m.content === "string") continue;
    for (const b of m.content) {
      const blk = b as { type?: string; content?: unknown };
      if (blk.type !== "tool_result" || typeof blk.content !== "string") continue;
      if (blk.content.length > head + 40) {
        blk.content = blk.content.slice(0, head) + `\n…[compacted: ${blk.content.length} chars — re-read the file if you need it]`;
        truncated++;
      }
    }
  }
  return truncated;
}

/** Compaction trigger: ~140k estimated tokens leaves headroom under a 200k
 *  window for the system prompt, tools, and the next turn's output. */
export const COMPACT_AT_TOKENS = 140_000;

/** Reset policy (#399): fresh context is a RECOVERY action, never the
 *  default. Three consecutive failed iterations on the same target = the
 *  reasoning is likely poisoned; escape it once, with a carried digest. */
export const RESET_AFTER_FAILURES = 3;

/** The digest a reset carries across — lessons survive the wipe. */
export function resetDigest(
  lessons: { iteration: number; note: string }[]
): string {
  if (lessons.length === 0) return "";
  const lines = lessons.slice(-6).map((l) => `- iter ${l.iteration}: ${l.note.slice(0, 300)}`);
  return `Context was RESET after repeated failures (a recovery, not a restart). Lessons that still bind:\n${lines.join("\n")}`;
}
