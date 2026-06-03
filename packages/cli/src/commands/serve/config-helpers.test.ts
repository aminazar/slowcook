import { describe, it, expect } from "vitest";
import { composeFiles, shouldBuildOnUp, ProfileConfigSchema, normaliseConfig } from "./config.js";

const parse = (p: object) => ProfileConfigSchema.parse(p);

describe("composeFiles", () => {
  it("returns compose_files when set (multi-`-f` shape)", () => {
    const p = parse({
      apps: {},
      compose_files: ["docker-compose.production.yml", "docker-compose.dev.yml"],
    });
    expect(composeFiles(p)).toEqual([
      "docker-compose.production.yml",
      "docker-compose.dev.yml",
    ]);
  });

  it("falls back to compose_overlay when only the legacy field is set", () => {
    const p = parse({ apps: {}, compose_overlay: "docker-compose.dev.yml" });
    expect(composeFiles(p)).toEqual(["docker-compose.dev.yml"]);
  });

  it("prefers compose_files over compose_overlay when both are set", () => {
    const p = parse({
      apps: {},
      compose_files: ["a.yml", "b.yml"],
      compose_overlay: "should-be-ignored.yml",
    });
    expect(composeFiles(p)).toEqual(["a.yml", "b.yml"]);
  });

  it("returns empty when neither is set", () => {
    expect(composeFiles(parse({ apps: {} }))).toEqual([]);
  });
});

describe("shouldBuildOnUp", () => {
  it("returns false for bind-mount-source mode (default — sc#173 #2)", () => {
    expect(shouldBuildOnUp(parse({ apps: {} }))).toBe(false);
    expect(shouldBuildOnUp(parse({ apps: {}, mode: "bind-mount-source" }))).toBe(false);
  });

  it("returns true for built-image mode", () => {
    expect(shouldBuildOnUp(parse({ apps: {}, mode: "built-image" }))).toBe(true);
  });
});

describe("normaliseConfig — compose_files round-trip", () => {
  it("preserves compose_files through legacy wrapping", () => {
    // Legacy (flat) shape can carry compose_files too — get wrapped into profiles.dev.
    const legacy = {
      schema_version: 1,
      apps: {},
      compose_files: ["base.yml", "dev.yml"],
    };
    const cfg = normaliseConfig(legacy, ".brewing/dev-env.yaml");
    expect(cfg.profiles.dev?.compose_files).toEqual(["base.yml", "dev.yml"]);
  });
});
