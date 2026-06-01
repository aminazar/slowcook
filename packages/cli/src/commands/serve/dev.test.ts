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
  it("up emits the compose command + seed line", () => {
    const result = planServeDev(
      { verb: "up", repoRoot: "/tmp" },
      baseCfg,
      profile,
    );
    expect(result.exitCode).toBe(0);
    expect(result.output.join("\n")).toContain("docker compose -f docker-compose/docker-compose.dev.yml up -d --build");
    expect(result.output.join("\n")).toContain("packages/seeds/dev/index.ts");
  });

  it("sync with dryRun + explicit --branch emits the planned push", () => {
    const result = planServeDev(
      { verb: "sync", branch: "feat/x", repoRoot: "/tmp", dryRun: true, story: "042" },
      baseCfg,
      profile,
    );
    expect(result.exitCode).toBe(0);
    const joined = result.output.join("\n");
    expect(joined).toContain("feat/x → origin/dev");
    expect(joined).toContain("story-042");
    expect(joined).toContain("git push --force origin feat/x:dev");
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

  it("down emits the compose down command + --prune drops volumes", () => {
    const plain = planServeDev({ verb: "down", repoRoot: "/tmp" }, baseCfg, profile);
    expect(plain.output.join("\n")).toContain("docker compose -f docker-compose/docker-compose.dev.yml down");
    expect(plain.output.join("\n")).not.toContain(" -v");

    const pruned = planServeDev({ verb: "down", repoRoot: "/tmp", prune: true }, baseCfg, profile);
    expect(pruned.output.join("\n")).toContain("docker compose -f docker-compose/docker-compose.dev.yml down -v");
  });

  it("logs supports --service + --follow", () => {
    const result = planServeDev(
      { verb: "logs", repoRoot: "/tmp", service: "patient", follow: true },
      baseCfg,
      profile,
    );
    expect(result.output.join("\n")).toContain("docker compose -f docker-compose/docker-compose.dev.yml logs -f patient");
  });

  it("reset is a no-op for the dev profile", () => {
    const result = planServeDev({ verb: "reset", repoRoot: "/tmp" }, baseCfg, profile);
    expect(result.exitCode).toBe(0);
    expect(result.output.join("\n")).toContain("only meaningful for staging");
  });

  it("unknown verb exits 64 with a hint", () => {
    const result = planServeDev({ verb: "wibble", repoRoot: "/tmp" }, baseCfg, profile);
    expect(result.exitCode).toBe(64);
    expect(result.output.join("\n")).toContain("Unknown verb");
  });

  it("up emits a clear notice when compose_overlay is absent", () => {
    const profileNoOverlay = { ...profile, compose_overlay: undefined };
    const result = planServeDev({ verb: "up", repoRoot: "/tmp" }, baseCfg, profileNoOverlay);
    expect(result.output.join("\n")).toContain("no compose_overlay set");
  });

  it("down errors when compose_overlay is absent", () => {
    const profileNoOverlay = { ...profile, compose_overlay: undefined };
    const result = planServeDev({ verb: "down", repoRoot: "/tmp" }, baseCfg, profileNoOverlay);
    expect(result.exitCode).toBe(64);
  });
});
