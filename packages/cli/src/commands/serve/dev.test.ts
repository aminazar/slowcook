import { describe, it, expect } from "vitest";
import { planServeDev } from "./dev.js";
import { normaliseConfig } from "./config.js";

const baseCfg = normaliseConfig(
  {
    schema_version: 1,
    profiles: {
      dev: {
        source_branch: "dev",
        compose_overlay: "docker-compose/docker-compose.dev.yml",
        apps: { patient: { mode: "next-dev", port: 3001 } },
        seed_script: "packages/seeds/dev/index.ts",
      },
    },
  },
  ".brewing/serve.yaml",
);
const profile = baseCfg.profiles.dev!;

describe("planServeDev", () => {
  it("up emits the compose-up command + seed command", () => {
    const result = planServeDev({ verb: "up", repoRoot: "/tmp" }, baseCfg, profile);
    expect(result.exitCode).toBe(0);
    const cmds = (result.commands ?? []).map((c) => c.cmd);
    // bind-mount-source default → no --build flag (sc#173 #2).
    expect(cmds).toContain("docker compose -f docker-compose/docker-compose.dev.yml up -d");
    expect(cmds).toContain("pnpm exec ts-node packages/seeds/dev/index.ts");
    // The bring-up command runs remotely (ssh-wrapped if ssh_target set).
    expect(result.commands?.[0]?.remote).toBe(true);
  });

  it("up with built-image mode includes --build", () => {
    const builtImageCfg = normaliseConfig(
      {
        schema_version: 1,
        profiles: {
          dev: { mode: "built-image", compose_overlay: "compose.yml", apps: {} },
        },
      },
      "x.yaml",
    );
    const result = planServeDev({ verb: "up", repoRoot: "/tmp" }, builtImageCfg, builtImageCfg.profiles.dev!);
    expect(result.commands?.[0]?.cmd).toContain("--build");
  });

  it("up supports compose_files (multi-`-f` base + overlay)", () => {
    const layeredCfg = normaliseConfig(
      {
        schema_version: 1,
        profiles: {
          dev: {
            compose_files: ["docker-compose.production.yml", "docker-compose.dev.yml"],
            apps: { patient: { mode: "next-dev", port: 3001 } },
          },
        },
      },
      "x.yaml",
    );
    const result = planServeDev({ verb: "up", repoRoot: "/tmp" }, layeredCfg, layeredCfg.profiles.dev!);
    expect(result.commands?.[0]?.cmd).toBe(
      "docker compose -f docker-compose.production.yml -f docker-compose.dev.yml up -d",
    );
  });

  it("sync with dryRun + explicit --branch emits the planned push", () => {
    const result = planServeDev(
      { verb: "sync", branch: "feat/x", repoRoot: "/tmp", dryRun: true, story: "042" },
      baseCfg,
      profile,
    );
    expect(result.exitCode).toBe(0);
    expect(result.output.join("\n")).toContain("feat/x → origin/dev");
    expect(result.output.join("\n")).toContain("story-042");
    expect(result.commands?.[0]?.cmd).toBe("git push --force origin feat/x:dev");
    // git push runs locally — never ssh-wrapped.
    expect(result.commands?.[0]?.remote).toBe(false);
  });

  it("sync rejects detached HEAD without --branch", () => {
    const result = planServeDev(
      { verb: "sync", branch: "HEAD", repoRoot: "/tmp", dryRun: true },
      baseCfg,
      profile,
    );
    expect(result.exitCode).toBe(64);
    expect(result.output.join("\n")).toContain("detached HEAD");
  });

  it("down emits compose down + --prune drops volumes", () => {
    const plain = planServeDev({ verb: "down", repoRoot: "/tmp" }, baseCfg, profile);
    expect(plain.commands?.[0]?.cmd).toBe("docker compose -f docker-compose/docker-compose.dev.yml down");

    const pruned = planServeDev({ verb: "down", repoRoot: "/tmp", prune: true }, baseCfg, profile);
    expect(pruned.commands?.[0]?.cmd).toBe("docker compose -f docker-compose/docker-compose.dev.yml down -v");
  });

  it("logs supports --service + --follow", () => {
    const result = planServeDev(
      { verb: "logs", repoRoot: "/tmp", service: "patient", follow: true },
      baseCfg,
      profile,
    );
    expect(result.commands?.[0]?.cmd).toBe("docker compose -f docker-compose/docker-compose.dev.yml logs -f patient");
  });

  it("reset is a no-op for the dev profile", () => {
    const result = planServeDev({ verb: "reset", repoRoot: "/tmp" }, baseCfg, profile);
    expect(result.exitCode).toBe(0);
    expect(result.output.join("\n")).toContain("only meaningful for staging");
    expect(result.commands).toBeUndefined();
  });

  it("unknown verb exits 64 with a hint", () => {
    const result = planServeDev({ verb: "wibble", repoRoot: "/tmp" }, baseCfg, profile);
    expect(result.exitCode).toBe(64);
    expect(result.output.join("\n")).toContain("Unknown verb");
  });

  it("up errors when neither compose_files nor compose_overlay is set", () => {
    const noFiles = { ...profile, compose_overlay: undefined, compose_files: undefined };
    const result = planServeDev({ verb: "up", repoRoot: "/tmp" }, baseCfg, noFiles);
    expect(result.exitCode).toBe(64);
  });

  it("down errors when neither compose_files nor compose_overlay is set", () => {
    const noFiles = { ...profile, compose_overlay: undefined, compose_files: undefined };
    const result = planServeDev({ verb: "down", repoRoot: "/tmp" }, baseCfg, noFiles);
    expect(result.exitCode).toBe(64);
  });
});
