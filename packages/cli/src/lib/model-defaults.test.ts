// dovizir handover §5 — "pin the model" was whack-a-mole because every stage
// carried a private default. These lock the cascade and the visibility.
import { describe, it, expect, vi } from "vitest";
import {
  resolveModel,
  modelSource,
  renderModelTable,
  STAGE_DEFAULTS,
  MODEL_ENV,
  assertModelPriced,
} from "./model-defaults.js";

const noEnv = {} as NodeJS.ProcessEnv;
const withEnv = { [MODEL_ENV]: "claude-opus-5" } as NodeJS.ProcessEnv;

describe("resolveModel", () => {
  it("falls back to the stage default", () => {
    expect(resolveModel("brew", undefined, noEnv)).toBe(STAGE_DEFAULTS.brew);
  });

  it("SLOWCOOK_MODEL covers EVERY stage — the fix for the reported symptom", () => {
    // The bug: --refine-model was honoured, the multifurcation (relationship)
    // round quietly kept its own default. One env var now reaches both.
    expect(resolveModel("refine", undefined, withEnv)).toBe("claude-opus-5");
    expect(resolveModel("relationship", undefined, withEnv)).toBe("claude-opus-5");
    expect(resolveModel("brew", undefined, withEnv)).toBe("claude-opus-5");
  });

  it("a stage flag still wins over the env", () => {
    expect(resolveModel("brew", "claude-haiku-4-5", withEnv)).toBe("claude-haiku-4-5");
  });

  it("ignores blank flags and blank env", () => {
    expect(resolveModel("brew", "   ", noEnv)).toBe(STAGE_DEFAULTS.brew);
    expect(resolveModel("brew", undefined, { [MODEL_ENV]: "  " } as NodeJS.ProcessEnv)).toBe(STAGE_DEFAULTS.brew);
  });
});

describe("stage defaults", () => {
  it("carries no stale dated pins — the drift this table replaced", () => {
    for (const [stage, model] of Object.entries(STAGE_DEFAULTS)) {
      expect(model, `${stage} is pinned to a dated snapshot`).not.toMatch(/-\d{8}$/);
    }
  });

  it("every stage has one", () => {
    expect(Object.values(STAGE_DEFAULTS).every((m) => m.startsWith("claude-"))).toBe(true);
  });
});

describe("renderModelTable", () => {
  it("names where each model came from, before any tokens are spent", () => {
    const out = renderModelTable(
      [{ stage: "refine", flag: "claude-opus-5" }, { stage: "relationship" }],
      noEnv
    );
    expect(out).toContain("refine");
    expect(out).toContain("claude-opus-5");
    expect(out).toContain("(flag)");
    expect(out).toContain(STAGE_DEFAULTS.relationship); // the one that used to surprise you
  });

  it("marks env-sourced rows", () => {
    expect(renderModelTable([{ stage: "brew" }], withEnv)).toContain("(env)");
    expect(modelSource("brew", undefined, withEnv)).toBe("env");
  });

  it("leaves plain defaults unannotated (quiet when nothing is unusual)", () => {
    expect(renderModelTable([{ stage: "brew" }], noEnv)).not.toContain("(");
  });
});

// dovizir handover R2 — recording `usd: null` after the fact was not enough.
// A budget guard that cannot price a call cannot stop it: $16.23 of real spend
// was reported as $0.00. An unpriced model must refuse to START.
describe("assertModelPriced (R2)", () => {
  const priced = (m: string) => m === "claude-opus-4-8";

  it("returns quietly for a priced model", () => {
    expect(() => assertModelPriced("brew", "claude-opus-4-8", priced)).not.toThrow();
  });

  it("refuses to start on an unpriced model", () => {
    const exit = vi.spyOn(process, "exit").mockImplementation((() => { throw new Error("exit"); }) as never);
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => assertModelPriced("brew", "claude-future-9", priced)).toThrow("exit");
    expect(exit).toHaveBeenCalledWith(78);
    // the message must say WHY refusing beats running
    expect(err.mock.calls[0]![0]).toContain("cannot be capped");
    exit.mockRestore(); err.mockRestore();
  });

  it("--allow-unpriced proceeds, but says what was given up", () => {
    const write = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    expect(() => assertModelPriced("brew", "claude-future-9", priced, { allowUnpriced: true })).not.toThrow();
    expect(String(write.mock.calls[0]![0])).toContain("budget caps in USD cannot be enforced");
    write.mockRestore();
  });
});

describe("per-stage model env (cheap-model season, 2026-08-27)", () => {
  it("SLOWCOOK_MODEL_<STAGE> outranks the global env, flag outranks both", () => {
    const env = { SLOWCOOK_MODEL: "claude-sonnet-5", SLOWCOOK_MODEL_BREW: "claude-haiku-4-5" } as NodeJS.ProcessEnv;
    expect(resolveModel("brew", undefined, env)).toBe("claude-haiku-4-5");
    expect(resolveModel("refine", undefined, env)).toBe("claude-sonnet-5");
    expect(resolveModel("brew", "claude-opus-4-8", env)).toBe("claude-opus-4-8");
    expect(modelSource("brew", undefined, env)).toBe("stage-env");
    expect(modelSource("refine", undefined, env)).toBe("env");
  });

  it("per-stage env alone falls through cleanly for other stages", () => {
    const env = { SLOWCOOK_MODEL_BREW: "claude-haiku-4-5" } as NodeJS.ProcessEnv;
    expect(resolveModel("brew", undefined, env)).toBe("claude-haiku-4-5");
    expect(resolveModel("taste", undefined, env)).toBe(STAGE_DEFAULTS.taste);
  });
});
