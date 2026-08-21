import { describe, it, expect } from "vitest";
import { truncatedEmissionError } from "./emission-guard.js";

const usage = { inputTokens: 1, outputTokens: 32000, cacheReadTokens: 0, cacheCreateTokens: 0 };

describe("truncatedEmissionError (D1 / G14)", () => {
  it("max_tokens = truncated, must not persist", () => {
    const err = truncatedEmissionError({ stopReason: "max_tokens", usage }, "refine story-019");
    expect(err).toMatch(/TRUNCATED/);
    expect(err).toMatch(/refine story-019/);
  });
  it("end_turn and unknown stop reasons are complete", () => {
    expect(truncatedEmissionError({ stopReason: "end_turn", usage }, "x")).toBeNull();
    expect(truncatedEmissionError({ stopReason: undefined, usage }, "x")).toBeNull();
  });
});
