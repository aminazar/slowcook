import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import YAML from "yaml";
import { budget } from "./index.js";
import { appendCostEntry } from "../../cost-store.js";

function makeRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "budget-cmd-test-"));
  mkdirSync(join(root, "specs"), { recursive: true });
  return root;
}

describe("slowcook budget subcommand (sc#66)", () => {
  let repo: string;
  let logs: string[];
  let errs: string[];
  let originalLog: typeof console.log;
  let originalError: typeof console.error;
  let originalExit: typeof process.exit;
  let exitCode: number | undefined;

  beforeEach(() => {
    repo = makeRepo();
    logs = [];
    errs = [];
    exitCode = undefined;
    originalLog = console.log;
    originalError = console.error;
    originalExit = process.exit;
    console.log = (...a: unknown[]) => {
      logs.push(a.map(String).join(" "));
    };
    console.error = (...a: unknown[]) => {
      errs.push(a.map(String).join(" "));
    };
    process.exit = ((code?: number) => {
      exitCode = code;
      throw new Error(`__EXIT__${code}`);
    }) as never;
  });

  afterEach(() => {
    console.log = originalLog;
    console.error = originalError;
    process.exit = originalExit;
  });

  async function run(args: string[]): Promise<void> {
    try {
      await budget(["--cwd", repo, ...args]);
    } catch (e) {
      if (!(e as Error).message.startsWith("__EXIT__")) throw e;
    }
  }

  it("show: tells you nothing's configured when budget.yaml absent", async () => {
    await run([]);
    expect(logs.join("\n")).toContain("No .brewing/budget.yaml");
    expect(logs.join("\n")).toContain("slowcook budget set --monthly");
  });

  it("set: creates config with --monthly", async () => {
    await run(["set", "--monthly", "50"]);
    expect(existsSync(join(repo, ".brewing", "budget.yaml"))).toBe(true);
    const parsed = YAML.parse(readFileSync(join(repo, ".brewing", "budget.yaml"), "utf8"));
    expect(parsed.monthly_budget_usd).toBe(50);
    expect(parsed.monthly_start_day).toBe(1);
    expect(parsed.schema_version).toBe(1);
  });

  it("set: accepts --start-day and --story", async () => {
    await run(["set", "--monthly", "50", "--start-day", "15", "--story", "10"]);
    const parsed = YAML.parse(readFileSync(join(repo, ".brewing", "budget.yaml"), "utf8"));
    expect(parsed.monthly_start_day).toBe(15);
    expect(parsed.story_budget_usd).toBe(10);
  });

  it("set: merges into existing config (only update --start-day)", async () => {
    await run(["set", "--monthly", "50"]);
    logs.length = 0;
    await run(["set", "--start-day", "20"]);
    const parsed = YAML.parse(readFileSync(join(repo, ".brewing", "budget.yaml"), "utf8"));
    expect(parsed.monthly_budget_usd).toBe(50);
    expect(parsed.monthly_start_day).toBe(20);
  });

  it("set: errors when neither --monthly nor --credit on a fresh repo", async () => {
    await run(["set", "--start-day", "5"]);
    expect(exitCode).toBe(2);
    expect(errs.join("\n")).toContain("at least one of --monthly or --credit");
  });

  it("set: creates a credit-only config with --credit", async () => {
    await run(["set", "--credit", "25", "--credit-baseline", "2026-05-15T00:00:00Z"]);
    const parsed = YAML.parse(readFileSync(join(repo, ".brewing", "budget.yaml"), "utf8"));
    expect(parsed.credit_balance_usd).toBe(25);
    expect(parsed.credit_baseline_at).toBe("2026-05-15T00:00:00Z");
    expect(parsed.monthly_budget_usd).toBeUndefined();
  });

  it("set: --credit captures 'now' as baseline when --credit-baseline omitted", async () => {
    await run(["set", "--credit", "25"]);
    const parsed = YAML.parse(readFileSync(join(repo, ".brewing", "budget.yaml"), "utf8"));
    expect(typeof parsed.credit_baseline_at).toBe("string");
    expect(parsed.credit_baseline_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("set: re-running --credit refreshes the baseline (top-up)", async () => {
    await run(["set", "--credit", "25", "--credit-baseline", "2026-04-01T00:00:00Z"]);
    logs.length = 0;
    await run(["set", "--credit", "50", "--credit-baseline", "2026-05-15T00:00:00Z"]);
    const parsed = YAML.parse(readFileSync(join(repo, ".brewing", "budget.yaml"), "utf8"));
    expect(parsed.credit_balance_usd).toBe(50);
    expect(parsed.credit_baseline_at).toBe("2026-05-15T00:00:00Z");
  });

  it("set: rejects non-positive --credit", async () => {
    await run(["set", "--credit", "0"]);
    expect(exitCode).toBe(2);
    expect(errs.join("\n")).toContain("--credit must be a positive number");
  });

  it("show: reports credit-balance gauge", async () => {
    await run(["set", "--credit", "25", "--credit-baseline", "2026-05-01T00:00:00Z"]);
    appendCostEntry(repo, "001", { agent: "refine", usd: 21, at: "2026-05-10T00:00:00Z" });
    logs.length = 0;
    await run([]);
    const out = logs.join("\n");
    expect(out).toContain("Anthropic credit");
    expect(out).toContain("$4.00 of $25.00");
    expect(out).toContain("⚠️");
  });

  it("set: rejects non-positive --monthly", async () => {
    await run(["set", "--monthly", "-1"]);
    expect(exitCode).toBe(2);
    expect(errs.join("\n")).toContain("positive");
  });

  it("set: rejects out-of-range --start-day", async () => {
    await run(["set", "--monthly", "50", "--start-day", "32"]);
    expect(exitCode).toBe(2);
    expect(errs.join("\n")).toContain("1-31");
  });

  it("rm: deletes config when present", async () => {
    await run(["set", "--monthly", "50"]);
    logs.length = 0;
    await run(["rm"]);
    expect(existsSync(join(repo, ".brewing", "budget.yaml"))).toBe(false);
    expect(logs.join("\n")).toContain("Fuel gauge now disabled");
  });

  it("rm: tolerates missing config", async () => {
    await run(["rm"]);
    expect(logs.join("\n")).toContain("nothing to remove");
  });

  it("show: reports period + spend from sidecars", async () => {
    await run(["set", "--monthly", "50"]);
    const now = new Date();
    const isoNow = now.toISOString();
    appendCostEntry(repo, "001", { agent: "refine", usd: 3.5, at: isoNow });
    logs.length = 0;
    await run([]);
    const out = logs.join("\n");
    expect(out).toContain("$3.50 of $50.00");
    expect(out).toContain("(7%)");
    expect(out).toContain("entry across 1 story");
  });

  it("show: surfaces warn threshold", async () => {
    await run(["set", "--monthly", "10"]);
    appendCostEntry(repo, "001", {
      agent: "refine",
      usd: 8.5,
      at: new Date().toISOString(),
    });
    logs.length = 0;
    await run([]);
    expect(logs.join("\n")).toContain("⚠️");
  });

  it("rejects unknown verb", async () => {
    await run(["bogus"]);
    expect(exitCode).toBe(2);
    expect(errs.join("\n")).toContain("Unknown budget action");
  });

  it("show: invalid config exits 2 with clear error", async () => {
    mkdirSync(join(repo, ".brewing"), { recursive: true });
    writeFileSync(
      join(repo, ".brewing", "budget.yaml"),
      "schema_version: 99\nmonthly_budget_usd: 50\n",
      "utf8"
    );
    await run([]);
    expect(exitCode).toBe(2);
    expect(errs.join("\n")).toContain("invalid");
  });
});
