// #399 — the ratchet is feedback, not a guillotine. Pure-half tests.
import { describe, it, expect } from "vitest";
import {
  estimateTokens,
  lessonMessage,
  compactOldToolResults,
  resetDigest,
  type Msg,
} from "./conversation.js";

describe("lessonMessage", () => {
  it("frames the revert as in-context feedback the next turn can cite", () => {
    const m = lessonMessage(3, "your edit was REVERTED because it broke 4 green test(s): deps-only-noble | no-ambient-clock");
    expect(m.role).toBe("user");
    expect(m.content).toContain("LESSON from iteration 3");
    expect(m.content).toContain("no-ambient-clock");     // the NAME survives
    expect(m.content).toContain("do not re-orient");     // the whole point
  });
});

describe("compactOldToolResults", () => {
  const toolResult = (s: string): Msg => ({
    role: "user",
    content: [{ type: "tool_result", tool_use_id: "t", content: s } as never],
  });

  it("truncates OLD tool results, keeps recent ones and the head intact", () => {
    const msgs: Msg[] = [
      { role: "user", content: "HEAD cached prefix" },
      toolResult("X".repeat(5000)),
      { role: "assistant", content: "reasoning that must survive" },
      toolResult("Y".repeat(5000)),
    ];
    const n = compactOldToolResults(msgs, { keepRecentMessages: 2, headChars: 100 });
    expect(n).toBe(1); // only the OLD one (index 1); index 3 is within keepRecent
    expect((msgs[1]!.content as { content: string }[])[0]!.content).toContain("compacted: 5000 chars");
    expect((msgs[3]!.content as { content: string }[])[0]!.content).toBe("Y".repeat(5000));
    expect(msgs[0]!.content).toBe("HEAD cached prefix");
    expect(msgs[2]!.content).toBe("reasoning that must survive");
  });

  it("never touches short results or assistant text", () => {
    const msgs: Msg[] = [
      { role: "user", content: "HEAD" },
      toolResult("short"),
      { role: "assistant", content: "A".repeat(9000) },
      { role: "user", content: "tail" },
    ];
    expect(compactOldToolResults(msgs, { keepRecentMessages: 1 })).toBe(0);
    expect(msgs[2]!.content).toBe("A".repeat(9000));
  });
});

describe("estimateTokens", () => {
  it("counts both string and block content", () => {
    const msgs: Msg[] = [
      { role: "user", content: "x".repeat(400) },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t", content: "y".repeat(400) } as never] },
    ];
    const t = estimateTokens(msgs);
    expect(t).toBeGreaterThanOrEqual(200);
    expect(t).toBeLessThan(300);
  });
});

describe("resetDigest", () => {
  it("carries lessons across the wipe, and says the reset is a recovery", () => {
    const d = resetDigest([{ iteration: 2, note: "overflow: call justify first" }, { iteration: 4, note: "broke no-ambient-clock" }]);
    expect(d).toContain("recovery, not a restart");
    expect(d).toContain("iter 4: broke no-ambient-clock");
  });
  it("is empty with no lessons — a reset with nothing learned adds nothing", () => {
    expect(resetDigest([])).toBe("");
  });
});
