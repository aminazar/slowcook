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
  it("up emits compose-up + a reachable URL hint", () => {
    const result = planServeMock({ verb: "up", repoRoot: "/tmp" }, cfg, profile);
    expect(result.exitCode).toBe(0);
    expect(result.commands?.[0]?.cmd).toBe(
      "docker compose -f docker-compose/docker-compose.mock.yml up -d",
    );
    expect(result.output.join("\n")).toContain(":5173");
  });

  it("up falls back to pnpm filter when compose isn't configured", () => {
    const noOverlay = { ...profile, compose_overlay: undefined };
    const result = planServeMock({ verb: "up", repoRoot: "/tmp" }, cfg, noOverlay);
    expect(result.exitCode).toBe(0);
    expect(result.commands?.[0]?.cmd).toBe("pnpm --filter ./mock dev");
    // Local fallback — no ssh wrap.
    expect(result.commands?.[0]?.remote).toBe(false);
  });

  it("sync emits git push", () => {
    const result = planServeMock(
      { verb: "sync", branch: "feat/mockup-42", repoRoot: "/tmp", dryRun: true },
      cfg,
      profile,
    );
    expect(result.exitCode).toBe(0);
    expect(result.commands?.[0]?.cmd).toBe("git push --force origin feat/mockup-42:main");
    expect(result.commands?.[0]?.remote).toBe(false);
  });

  it("sync rejects detached HEAD without --branch", () => {
    const result = planServeMock({ verb: "sync", branch: "HEAD", repoRoot: "/tmp", dryRun: true }, cfg, profile);
    expect(result.exitCode).toBe(64);
  });

  it("down + --prune drops volumes", () => {
    const plain = planServeMock({ verb: "down", repoRoot: "/tmp" }, cfg, profile);
    expect(plain.commands?.[0]?.cmd).toBe("docker compose -f docker-compose/docker-compose.mock.yml down");
    const pruned = planServeMock({ verb: "down", repoRoot: "/tmp", prune: true }, cfg, profile);
    expect(pruned.commands?.[0]?.cmd).toBe("docker compose -f docker-compose/docker-compose.mock.yml down -v");
  });

  it("logs supports --service + --follow", () => {
    const result = planServeMock(
      { verb: "logs", repoRoot: "/tmp", service: "mock-vite", follow: true },
      cfg,
      profile,
    );
    expect(result.commands?.[0]?.cmd).toBe(
      "docker compose -f docker-compose/docker-compose.mock.yml logs -f mock-vite",
    );
  });

  it("reset is a no-op for mock", () => {
    const result = planServeMock({ verb: "reset", repoRoot: "/tmp" }, cfg, profile);
    expect(result.exitCode).toBe(0);
    expect(result.output.join("\n")).toContain("only meaningful for staging");
  });

  it("unknown verb exits 64", () => {
    expect(planServeMock({ verb: "wibble", repoRoot: "/tmp" }, cfg, profile).exitCode).toBe(64);
  });

  it("down errors when neither compose_files nor compose_overlay set", () => {
    const noFiles = { ...profile, compose_overlay: undefined };
    expect(planServeMock({ verb: "down", repoRoot: "/tmp" }, cfg, noFiles).exitCode).toBe(64);
  });
});
