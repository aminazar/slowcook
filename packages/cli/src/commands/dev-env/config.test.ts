import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadDevEnvConfig, DEV_ENV_CONFIG_PATH } from "./config.js";

let repo: string;

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "slowcook-dev-env-"));
  mkdirSync(join(repo, ".brewing"), { recursive: true });
});
afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

function writeConfig(yaml: string): void {
  writeFileSync(join(repo, DEV_ENV_CONFIG_PATH), yaml, "utf8");
}

describe("loadDevEnvConfig — happy path", () => {
  it("parses a minimal valid config", () => {
    writeConfig(`
schema_version: 1
apps:
  patient:
    mode: dev
    port: 3001
`);
    const config = loadDevEnvConfig(repo);
    expect(config.schema_version).toBe(1);
    expect(config.source_branch).toBe("dev"); // default
    expect(config.apps.patient!.mode).toBe("dev");
    expect(config.apps.patient!.port).toBe(3001);
    expect(config.apps.patient!.autoheal).toBe(true); // default
  });

  it("parses a full config with all optional fields", () => {
    writeConfig(`
schema_version: 1
source_branch: dev
seed_script: scripts/seed-dev-data.ts
ssh_target:
  host: delgoosh-box
  user: gha-runner
  checkout_dir: /opt/delgoosh-dev
  key_secret: DELGOOSH_DEV_SSH_KEY
persistence:
  db_volume: pg-dev-data
  uploads_volume: minio-dev-data
apps:
  patient:
    mode: dev
    port: 3001
  back:
    mode: nest-watch
    port: 4000
    autoheal: false
  admin:
    mode: start
    port: 3000
    container: delgoosh-admin
`);
    const config = loadDevEnvConfig(repo);
    expect(config.seed_script).toBe("scripts/seed-dev-data.ts");
    expect(config.ssh_target?.host).toBe("delgoosh-box");
    expect(config.ssh_target?.key_secret).toBe("DELGOOSH_DEV_SSH_KEY");
    expect(config.persistence.db_volume).toBe("pg-dev-data");
    expect(Object.keys(config.apps).sort()).toEqual(["admin", "back", "patient"]);
    expect(config.apps.back!.mode).toBe("nest-watch");
    expect(config.apps.back!.autoheal).toBe(false);
    expect(config.apps.admin!.container).toBe("delgoosh-admin");
  });

  it("accepts every documented mode", () => {
    writeConfig(`
schema_version: 1
apps:
  a: { mode: dev, port: 3001 }
  b: { mode: start, port: 3002 }
  c: { mode: nest-watch, port: 4000 }
  d: { mode: static, port: 8080 }
  e: { mode: none, port: 9000 }
`);
    const config = loadDevEnvConfig(repo);
    expect(Object.values(config.apps).map((a) => a.mode).sort()).toEqual([
      "dev",
      "nest-watch",
      "none",
      "start",
      "static",
    ]);
  });
});

describe("loadDevEnvConfig — failures", () => {
  it("throws when the file is missing", () => {
    expect(() => loadDevEnvConfig(repo)).toThrow(/not found/);
  });

  it("throws on malformed YAML", () => {
    writeConfig("not: valid: yaml: { because");
    expect(() => loadDevEnvConfig(repo)).toThrow(/not valid YAML/);
  });

  it("rejects unknown mode", () => {
    writeConfig(`
schema_version: 1
apps:
  x:
    mode: bogus
    port: 3001
`);
    expect(() => loadDevEnvConfig(repo)).toThrow(/failed validation/);
  });

  it("rejects negative port", () => {
    writeConfig(`
schema_version: 1
apps:
  x:
    mode: dev
    port: -1
`);
    expect(() => loadDevEnvConfig(repo)).toThrow(/failed validation/);
  });

  it("rejects wrong schema_version", () => {
    writeConfig(`
schema_version: 2
apps:
  x: { mode: dev, port: 3001 }
`);
    expect(() => loadDevEnvConfig(repo)).toThrow(/failed validation/);
  });

  it("rejects ssh_target with missing required fields", () => {
    writeConfig(`
schema_version: 1
ssh_target:
  host: delgoosh-box
apps:
  x: { mode: dev, port: 3001 }
`);
    expect(() => loadDevEnvConfig(repo)).toThrow(/failed validation/);
  });
});
