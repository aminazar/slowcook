import { describe, it, expect, afterEach } from "vitest";
import { defineScenarios, resolveScenario } from "./scenarios.js";
import type { Scenario } from "./types.js";

const s = (id: string, name = `Scenario ${id}`): Scenario => ({
  id,
  name,
  user: null,
  initialPath: `/${id}`,
  fixtures: {},
});

describe("defineScenarios", () => {
  it("builds a registry with byId + list + default", () => {
    const a = s("a");
    const b = s("b");
    const reg = defineScenarios([a, b]);
    expect(reg.byId).toEqual({ a, b });
    expect(reg.list).toEqual([a, b]);
    expect(reg.default).toBe(a);
  });

  it("default is null on empty list", () => {
    const reg = defineScenarios([]);
    expect(reg.default).toBeNull();
    expect(reg.list).toEqual([]);
  });

  it("throws on duplicate id (catches copy-paste-without-rename)", () => {
    expect(() =>
      defineScenarios([s("dup"), s("dup", "different name")])
    ).toThrow(/duplicate scenario id "dup"/);
  });
});

describe("resolveScenario", () => {
  const env = process.env;
  afterEach(() => {
    process.env = env;
  });

  it("query param wins when matching", () => {
    const a = s("a");
    const b = s("b");
    const reg = defineScenarios([a, b]);
    expect(resolveScenario(reg, "b")).toBe(b);
  });

  it("query param ignored when not matching → falls through to env / default", () => {
    const a = s("a");
    const reg = defineScenarios([a]);
    expect(resolveScenario(reg, "nonexistent")).toBe(a);
  });

  it("env var picks scenario when no query param", () => {
    const a = s("a");
    const b = s("b");
    const reg = defineScenarios([a, b]);
    process.env = { ...env, MOCK_SCENARIO: "b" };
    expect(resolveScenario(reg, null)).toBe(b);
  });

  it("env var ignored when not in registry → falls through to default", () => {
    const a = s("a");
    const reg = defineScenarios([a]);
    process.env = { ...env, MOCK_SCENARIO: "nonexistent" };
    expect(resolveScenario(reg, null)).toBe(a);
  });

  it("returns null when registry empty + nothing else resolves", () => {
    const reg = defineScenarios([]);
    expect(resolveScenario(reg, null)).toBeNull();
    expect(resolveScenario(reg, "anything")).toBeNull();
  });

  it("query param empty string treated as no value", () => {
    const a = s("a");
    const reg = defineScenarios([a]);
    expect(resolveScenario(reg, "")).toBe(a);
  });
});
