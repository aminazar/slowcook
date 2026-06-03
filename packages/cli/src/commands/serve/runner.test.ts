import { describe, it, expect } from "vitest";
import { resolveCommand, runCommands } from "./runner.js";
import { ProfileConfigSchema } from "./config.js";

const remoteProfile = ProfileConfigSchema.parse({
  apps: {},
  ssh_target: {
    host: "dev.example.com",
    user: "deploy",
    checkout_dir: "/opt/checkout",
  },
});

const localProfile = ProfileConfigSchema.parse({ apps: {} });

describe("resolveCommand", () => {
  it("local commands pass through unchanged regardless of profile", () => {
    expect(resolveCommand({ cmd: "git push", remote: false }, remoteProfile)).toBe("git push");
    expect(resolveCommand({ cmd: "git push", remote: false }, localProfile)).toBe("git push");
  });

  it("remote commands are ssh-wrapped when ssh_target is set", () => {
    const wrapped = resolveCommand({ cmd: "docker compose up", remote: true }, remoteProfile);
    expect(wrapped).toBe(`ssh deploy@dev.example.com 'cd /opt/checkout && docker compose up'`);
  });

  it("remote commands fall back to local when ssh_target is absent", () => {
    expect(resolveCommand({ cmd: "docker compose up", remote: true }, localProfile)).toBe(
      "docker compose up",
    );
  });

  it("escapes embedded single-quotes in remote commands", () => {
    const wrapped = resolveCommand(
      { cmd: `bash -c 'echo hi'`, remote: true },
      remoteProfile,
    );
    expect(wrapped).toBe(
      `ssh deploy@dev.example.com 'cd /opt/checkout && bash -c '\\''echo hi'\\'''`,
    );
  });
});

describe("runCommands (dry-run path)", () => {
  it("emits 'would run:' lines without executing", () => {
    const result = runCommands({
      commands: [
        { cmd: "docker compose up -d", remote: true, label: "bring up" },
        { cmd: "pnpm exec ts-node seed.ts", remote: true, label: "seed" },
      ],
      profile: remoteProfile,
      repoRoot: "/tmp",
      dryRun: true,
    });
    expect(result.exitCode).toBe(0);
    const joined = result.output.join("\n");
    expect(joined).toContain("bring up");
    expect(joined).toContain(
      `would run: ssh deploy@dev.example.com 'cd /opt/checkout && docker compose up -d'`,
    );
    expect(joined).toContain(
      `would run: ssh deploy@dev.example.com 'cd /opt/checkout && pnpm exec ts-node seed.ts'`,
    );
  });

  it("handles an empty commands list as no-op", () => {
    const result = runCommands({ commands: [], profile: localProfile, repoRoot: "/tmp", dryRun: true });
    expect(result.exitCode).toBe(0);
    expect(result.output).toEqual([]);
  });
});
