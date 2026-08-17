import { describe, it, expect } from "vitest";
import { validateStackConfig, resolveSuiteEnv, StackConfigError } from "./stack-config.js";

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

// Parity with stack-solidity: suites parameterised by environment (a plug-in
// implementation, a fixture mode, a base URL) must be expressible, or brew
// silently drives the suite's default.
describe("suite env", () => {
  const withEnv = (env: unknown) =>
    validateStackConfig({
      language: "typescript",
      test: {
        backend: {
          runner: "vitest",
          run_command: "npx vitest run",
          discover_command: "npx vitest list",
          reporter_format: "vitest-list-lines",
          env,
        },
      },
    });

  it("carries declared env through validation", () => {
    expect(withEnv({ TEST_MODE: "integration" }).test!["backend"]!.env).toEqual({
      TEST_MODE: "integration",
    });
  });

  it("leaves env undefined when none is declared", () => {
    expect(validateStackConfig({
      language: "typescript",
      test: {
        backend: {
          runner: "vitest",
          run_command: "npx vitest run",
          discover_command: "npx vitest list",
          reporter_format: "vitest-list-lines",
        },
      },
    }).test!["backend"]!.env).toBeUndefined();
  });

  it("refuses non-string values and non-object env", () => {
    expect(() => withEnv({ PORT: 5432 })).toThrow(/env\.PORT must be a string, got number/);
    expect(() => withEnv("A=1")).toThrow(/must be an object of string values/);
  });
});

describe("resolveSuiteEnv", () => {
  it("expands ${VAR} and names an unset one", () => {
    expect(resolveSuiteEnv({ URL: "${BASE}/api" }, { BASE: "http://h" } as NodeJS.ProcessEnv))
      .toEqual({ URL: "http://h/api" });
    expect(() => resolveSuiteEnv({ URL: "${NOPE_UNSET}" }, {} as NodeJS.ProcessEnv))
      .toThrow(/NOPE_UNSET/);
  });
});
