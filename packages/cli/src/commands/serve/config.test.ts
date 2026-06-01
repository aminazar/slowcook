import { describe, it, expect } from "vitest";
import { normaliseConfig, ServeConfigSchema, ProfileConfigSchema, getProfile } from "./config.js";

describe("normaliseConfig", () => {
  it("wraps legacy flat shape as profiles.dev", () => {
    const legacy = {
      schema_version: 1,
      source_branch: "dev",
      apps: { patient: { mode: "dev", port: 3001 } },
    };
    const normalised = normaliseConfig(legacy, ".brewing/dev-env.yaml");
    expect(Object.keys(normalised.profiles)).toEqual(["dev"]);
    expect(normalised.profiles.dev?.source_branch).toBe("dev");
    expect(normalised.profiles.dev?.apps.patient?.port).toBe(3001);
  });

  it("accepts new shape with explicit profiles map", () => {
    const newShape = {
      schema_version: 1,
      profiles: {
        dev: { source_branch: "dev", apps: { patient: { mode: "next-dev", port: 3001 } } },
        mock: { source_branch: "main", apps: { "mock-vite": { mode: "vite-dev", port: 5173 } } },
        staging: {
          mode: "built-image",
          source_branch: "main",
          apps: { patient: { mode: "next-start", port: 3101 } },
          seed: {
            scenarios: { demo: { scripts: ["packages/seeds/demo/*.ts"] } },
            guard_env: "STAGING_RESET_ALLOWED",
          },
        },
      },
    };
    const normalised = normaliseConfig(newShape, ".brewing/serve.yaml");
    expect(Object.keys(normalised.profiles).sort()).toEqual(["dev", "mock", "staging"]);
    expect(normalised.profiles.staging?.mode).toBe("built-image");
    expect(normalised.profiles.staging?.seed?.scenarios.demo?.scripts).toEqual([
      "packages/seeds/demo/*.ts",
    ]);
  });

  it("rejects non-object input", () => {
    expect(() => normaliseConfig("oh no", "x.yaml")).toThrow(/top level/);
    expect(() => normaliseConfig(null, "x.yaml")).toThrow(/top level/);
  });

  it("surfaces zod errors with the source path", () => {
    const bad = { schema_version: 1, profiles: { dev: { apps: { patient: { mode: "bogus", port: 3001 } } } } };
    expect(() => normaliseConfig(bad, "x.yaml")).toThrow(/x\.yaml.*mode/);
  });

  it("defaults profile mode to bind-mount-source when omitted", () => {
    const minimal = { schema_version: 1, profiles: { dev: { apps: {} } } };
    const normalised = normaliseConfig(minimal, "x.yaml");
    expect(normalised.profiles.dev?.mode).toBe("bind-mount-source");
  });
});

describe("getProfile", () => {
  it("returns undefined for unknown profile names", () => {
    const cfg = ServeConfigSchema.parse({
      schema_version: 1,
      profiles: { dev: ProfileConfigSchema.parse({ apps: {} }) },
    });
    expect(getProfile(cfg, "mock")).toBeUndefined();
    expect(getProfile(cfg, "dev")?.mode).toBe("bind-mount-source");
  });
});
