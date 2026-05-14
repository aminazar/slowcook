import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import YAML from "yaml";
import { detectAppsForInit, renderDevEnvYaml } from "./init.js";

let repo: string;

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "slowcook-dev-env-init-"));
});
afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

function writeApp(name: string, pkg: object): void {
  const dir = join(repo, "apps", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify(pkg, null, 2));
}

describe("detectAppsForInit", () => {
  it("returns empty when apps/ is missing", () => {
    expect(detectAppsForInit(repo)).toEqual([]);
  });

  it("classifies Next, Nest, and fallback apps by deps", () => {
    writeApp("web", { dependencies: { next: "14.0.0" } });
    writeApp("api", { dependencies: { "@nestjs/core": "10.0.0" } });
    writeApp("worker", { dependencies: { lodash: "4.0.0" } });
    const apps = detectAppsForInit(repo);
    expect(apps.find((a) => a.name === "web")?.mode).toBe("dev");
    expect(apps.find((a) => a.name === "api")?.mode).toBe("nest-watch");
    expect(apps.find((a) => a.name === "worker")?.mode).toBe("start");
  });

  it("assigns sequential ports starting at 3000", () => {
    writeApp("alpha", { dependencies: { next: "14" } });
    writeApp("beta", { dependencies: { next: "14" } });
    writeApp("gamma", { dependencies: { next: "14" } });
    const apps = detectAppsForInit(repo);
    expect(apps.map((a) => a.port)).toEqual([3000, 3001, 3002]);
  });

  it("ignores non-directory entries and dirs without package.json", () => {
    writeApp("real", { dependencies: { next: "14" } });
    mkdirSync(join(repo, "apps", "empty-dir"), { recursive: true });
    writeFileSync(join(repo, "apps", "stray.txt"), "not an app");
    const apps = detectAppsForInit(repo);
    expect(apps.map((a) => a.name)).toEqual(["real"]);
  });

  it("respects custom apps-dir", () => {
    mkdirSync(join(repo, "services", "svc-a"), { recursive: true });
    writeFileSync(
      join(repo, "services", "svc-a", "package.json"),
      JSON.stringify({ dependencies: { "@nestjs/common": "10" } }),
    );
    const apps = detectAppsForInit(repo, "services");
    expect(apps).toHaveLength(1);
    expect(apps[0]!.mode).toBe("nest-watch");
  });

  it("recognises Next via devDependencies", () => {
    writeApp("web", { devDependencies: { next: "14.0.0" } });
    const apps = detectAppsForInit(repo);
    expect(apps[0]!.mode).toBe("dev");
  });
});

describe("renderDevEnvYaml", () => {
  it("produces valid YAML that the config schema accepts shape-wise", () => {
    const yaml = renderDevEnvYaml([
      { name: "patient", mode: "dev", port: 3001 },
      { name: "back", mode: "nest-watch", port: 4000 },
    ]);
    const parsed = YAML.parse(yaml);
    expect(parsed.schema_version).toBe(1);
    expect(parsed.source_branch).toBe("dev");
    expect(parsed.apps.patient.mode).toBe("dev");
    expect(parsed.apps.patient.port).toBe(3001);
    expect(parsed.apps.back.mode).toBe("nest-watch");
    // ssh_target should be present but flagged as needing replacement
    expect(parsed.ssh_target.host).toMatch(/REPLACE_ME/);
  });

  it("includes a header banner pointing at the schema source", () => {
    const yaml = renderDevEnvYaml([{ name: "x", mode: "start", port: 3000 }]);
    expect(yaml).toContain("# slowcook dev-env config");
    expect(yaml).toContain("# Hand-tweak");
    expect(yaml).toContain("zod schema");
  });
});
