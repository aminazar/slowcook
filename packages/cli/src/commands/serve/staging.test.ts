import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { planServeStaging } from "./staging.js";
import { normaliseConfig } from "./config.js";

const cfg = normaliseConfig(
  {
    schema_version: 1,
    profiles: {
      staging: {
        mode: "built-image",
        source_branch: "main",
        compose_overlay: "docker-compose/docker-compose.staging.yml",
        bringup_cmd: "./redeploy.sh",
        apps: { patient: { mode: "next-start", port: 3101 } },
        seed: {
          scenarios: {
            demo: { scripts: ["packages/seeds/demo/index.ts"] },
            enterprise: { scripts: ["packages/seeds/enterprise/index.ts"] },
          },
          guard_env: "STAGING_RESET_ALLOWED",
        },
      },
    },
  },
  ".brewing/serve.yaml",
);
const profile = cfg.profiles.staging!;

describe("planServeStaging", () => {
  it("up shells out to bringup_cmd when set (Trade-off #3: consumer owns image build)", () => {
    const result = planServeStaging({ verb: "up", repoRoot: "/tmp" }, cfg, profile);
    expect(result.exitCode).toBe(0);
    expect(result.commands?.[0]?.cmd).toBe("./redeploy.sh");
    expect(result.commands?.[0]?.remote).toBe(true);
  });

  it("up falls back to compose when only compose_overlay is set", () => {
    const noBringup = { ...profile, bringup_cmd: undefined };
    const result = planServeStaging({ verb: "up", repoRoot: "/tmp" }, cfg, noBringup);
    expect(result.exitCode).toBe(0);
    // built-image profile → --build IS included.
    expect(result.commands?.[0]?.cmd).toBe(
      "docker compose -f docker-compose/docker-compose.staging.yml up -d --build",
    );
  });

  it("up errors when neither bringup_cmd nor compose is set", () => {
    const bare = { ...profile, bringup_cmd: undefined, compose_overlay: undefined };
    expect(planServeStaging({ verb: "up", repoRoot: "/tmp" }, cfg, bare).exitCode).toBe(64);
  });

  it("sync emits git push", () => {
    const result = planServeStaging(
      { verb: "sync", branch: "release/v2", repoRoot: "/tmp", dryRun: true },
      cfg,
      profile,
    );
    expect(result.commands?.[0]?.cmd).toBe("git push --force origin release/v2:main");
    expect(result.commands?.[0]?.remote).toBe(false);
  });

  it("down + --prune drops volumes", () => {
    const pruned = planServeStaging({ verb: "down", repoRoot: "/tmp", prune: true }, cfg, profile);
    expect(pruned.commands?.[0]?.cmd).toBe(
      "docker compose -f docker-compose/docker-compose.staging.yml down -v",
    );
  });
});

describe("planServeStaging — reset (scenarios + guard env)", () => {
  beforeEach(() => {
    delete process.env["STAGING_RESET_ALLOWED"];
  });
  afterEach(() => {
    delete process.env["STAGING_RESET_ALLOWED"];
  });

  it("reset without --scenario reports available scenarios", () => {
    const result = planServeStaging({ verb: "reset", repoRoot: "/tmp" }, cfg, profile);
    expect(result.exitCode).toBe(64);
    expect(result.output.join("\n")).toMatch(/--scenario.*required/);
    expect(result.output.join("\n")).toContain("demo, enterprise");
  });

  it("reset with unknown scenario reports the available list", () => {
    process.env["STAGING_RESET_ALLOWED"] = "1";
    const result = planServeStaging({ verb: "reset", scenario: "bogus", repoRoot: "/tmp" }, cfg, profile);
    expect(result.exitCode).toBe(64);
    expect(result.output.join("\n")).toContain("not found");
  });

  it("reset blocks when guard_env is unset", () => {
    const result = planServeStaging({ verb: "reset", scenario: "demo", repoRoot: "/tmp" }, cfg, profile);
    expect(result.exitCode).toBe(1);
    expect(result.output.join("\n")).toContain("STAGING_RESET_ALLOWED");
  });

  it("reset with guard_env set emits the planned seed commands", () => {
    process.env["STAGING_RESET_ALLOWED"] = "1";
    const result = planServeStaging(
      { verb: "reset", scenario: "demo", repoRoot: "/tmp" },
      cfg,
      profile,
    );
    expect(result.exitCode).toBe(0);
    expect(result.commands?.map((c) => c.cmd)).toEqual([
      "pnpm exec ts-node packages/seeds/demo/index.ts",
    ]);
    expect(result.commands?.[0]?.remote).toBe(true);
  });

  it("reset works on a profile without guard_env (no safety net)", () => {
    const noGuard = {
      ...profile,
      seed: { scenarios: profile.seed!.scenarios, guard_env: undefined },
    };
    const result = planServeStaging(
      { verb: "reset", scenario: "demo", repoRoot: "/tmp" },
      cfg,
      noGuard,
    );
    expect(result.exitCode).toBe(0);
  });
});
