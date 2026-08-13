// dovizir handover §5 — "pin the model" was whack-a-mole because every stage
// carried a private default. These lock the cascade and the visibility.
import { describe, it, expect } from "vitest";
import {
  resolveModel,
  modelSource,
  renderModelTable,
  STAGE_DEFAULTS,
  MODEL_ENV,
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
