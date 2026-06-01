import { describe, it, expect } from "vitest";
import { planServeMock } from "./mock.js";
import { normaliseConfig } from "./config.js";

const cfg = normaliseConfig(
  {
    schema_version: 1,
    profiles: {
      mock: {
        source_branch: "main",
        compose_overlay: "docker-compose/docker-compose.mock.yml",
        apps: { "mock-vite": { mode: "vite-dev", port: 5173 } },
      },
    },
  },
  ".brewing/serve.yaml",
);
const profile = cfg.profiles.mock!;

describe("planServeMock", () => {
  it("up emits the compose command + a reachable URL hint", () => {
    const result = planServeMock({ verb: "up", repoRoot: "/tmp" }, cfg, profile);
    expect(result.exitCode).toBe(0);
    const joined = result.output.join("\n");
    expect(joined).toContain("docker compose -f docker-compose/docker-compose.mock.yml up -d --build");
    expect(joined).toContain(":5173");
  });

  it("up falls back to pnpm filter when compose_overlay is unset", () => {
    const noOverlay = { ...profile, compose_overlay: undefined };
    const result = planServeMock({ verb: "up", repoRoot: "/tmp" }, cfg, noOverlay);
    expect(result.exitCode).toBe(0);
    expect(result.output.join("\n")).toContain("pnpm --filter ./mock dev");
  });

  it("sync with dryRun + --branch emits the planned push", () => {
    const result = planServeMock(
      { verb: "sync", branch: "feat/mockup-42", repoRoot: "/tmp", dryRun: true },
      cfg,
      profile,
    );
    expect(result.exitCode).toBe(0);
    expect(result.output.join("\n")).toContain("feat/mockup-42 → origin/main");
    expect(result.output.join("\n")).toContain("git push --force origin feat/mockup-42:main");
  });

  it("sync rejects detached HEAD without --branch", () => {
    const result = planServeMock({ verb: "sync", branch: "HEAD", repoRoot: "/tmp", dryRun: true }, cfg, profile);
    expect(result.exitCode).toBe(64);
    expect(result.output.join("\n")).toContain("detached HEAD");
  });

  it("down + --prune drops volumes", () => {
    const plain = planServeMock({ verb: "down", repoRoot: "/tmp" }, cfg, profile);
    expect(plain.output.join("\n")).toContain("docker compose -f docker-compose/docker-compose.mock.yml down");
    expect(plain.output.join("\n")).not.toContain(" -v");

    const pruned = planServeMock({ verb: "down", repoRoot: "/tmp", prune: true }, cfg, profile);
    expect(pruned.output.join("\n")).toContain("docker compose -f docker-compose/docker-compose.mock.yml down -v");
  });

  it("logs supports --service + --follow", () => {
    const result = planServeMock(
      { verb: "logs", repoRoot: "/tmp", service: "mock-vite", follow: true },
      cfg,
      profile,
    );
    expect(result.output.join("\n")).toContain("docker compose -f docker-compose/docker-compose.mock.yml logs -f mock-vite");
  });

  it("reset is a no-op for mock", () => {
    const result = planServeMock({ verb: "reset", repoRoot: "/tmp" }, cfg, profile);
    expect(result.exitCode).toBe(0);
    expect(result.output.join("\n")).toContain("only meaningful for staging");
  });

  it("unknown verb exits 64 with a hint", () => {
    const result = planServeMock({ verb: "wibble", repoRoot: "/tmp" }, cfg, profile);
    expect(result.exitCode).toBe(64);
  });

  it("down errors when compose_overlay is absent", () => {
    const noOverlay = { ...profile, compose_overlay: undefined };
    expect(planServeMock({ verb: "down", repoRoot: "/tmp" }, cfg, noOverlay).exitCode).toBe(64);
  });
});
