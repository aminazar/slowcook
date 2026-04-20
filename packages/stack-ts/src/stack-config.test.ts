import { describe, it, expect } from "vitest";
import { validateStackConfig, StackConfigError } from "./stack-config.js";

const VALID: Record<string, unknown> = {
  language: "typescript",
  package_manager: "npm",
  test: {
    backend: {
      runner: "vitest",
      run_command: "npx vitest run",
      discover_command: "npx vitest list",
      reporter_format: "vitest-list-lines",
    },
  },
};

describe("validateStackConfig", () => {
  it("accepts a minimal valid config", () => {
    const c = validateStackConfig(VALID);
    expect(c.language).toBe("typescript");
    expect(c.test?.["backend"]?.runner).toBe("vitest");
  });

  it("accepts extra fields it does not understand (forward compat)", () => {
    const c = validateStackConfig({
      ...VALID,
      coverage: { tool: "vitest-c8", floor_percent: 80 },
      future_field: 42,
    });
    expect(c.language).toBe("typescript");
  });

  it("rejects non-object input", () => {
    expect(() => validateStackConfig("nope")).toThrow(StackConfigError);
    expect(() => validateStackConfig(null)).toThrow(StackConfigError);
    expect(() => validateStackConfig(42)).toThrow(StackConfigError);
  });

  it("rejects bad language", () => {
    expect(() =>
      validateStackConfig({ ...VALID, language: "klingon" })
    ).toThrow(/'language'/);
  });

  it("rejects suite missing required fields", () => {
    expect(() =>
      validateStackConfig({
        language: "typescript",
        test: { backend: { runner: "vitest" /* missing others */ } },
      })
    ).toThrow(/missing required fields/);
  });

  it("accepts a config with no test suites", () => {
    const c = validateStackConfig({ language: "typescript" });
    expect(c.test).toBeUndefined();
  });
});
