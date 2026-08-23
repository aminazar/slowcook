import { describe, it, expect } from "vitest";
import { runTests, parseVitestJson, parsePlaywrightRunJson } from "./run.js";
import type { StackConfig } from "./stack-config.js";

function mkConfig(runCommand = "npx vitest run"): StackConfig {
  return {
    language: "typescript",
    test: {
      backend: {
        runner: "vitest",
        run_command: runCommand,
        discover_command: "npx vitest list",
        reporter_format: "vitest-list-lines",
      },
    },
  };
}

const SAMPLE_VITEST_JSON = JSON.stringify({
  numFailedTests: 1,
  numPassedTests: 2,
  testResults: [
    {
      name: "/abs/repo/tests/integration/story-001.test.ts",
      assertionResults: [
        {
          fullName: "POST /api/reactions > creates a reaction",
          title: "creates a reaction",
          ancestorTitles: ["POST /api/reactions"],
          status: "passed",
          duration: 42,
        },
        {
          fullName: "POST /api/reactions > rejects on self-report",
          title: "rejects on self-report",
          ancestorTitles: ["POST /api/reactions"],
          status: "passed",
          duration: 33,
        },
        {
          fullName: "POST /api/reactions > rejects when ration exhausted",
          title: "rejects when ration exhausted",
          ancestorTitles: ["POST /api/reactions"],
          status: "failed",
          duration: 15,
          failureMessages: ["AssertionError: expected 200 to equal 429"],
        },
      ],
    },
  ],
});

describe("parseVitestJson", () => {
  it("extracts test results from a clean vitest JSON output", () => {
    const tests = parseVitestJson(SAMPLE_VITEST_JSON, "npx vitest run");
    expect(tests).toHaveLength(3);
    expect(tests[0]).toMatchObject({
      file: "tests/integration/story-001.test.ts",
      status: "passed",
    });
    expect(tests[2]).toMatchObject({
      status: "failed",
      failure_message: expect.stringContaining("429"),
    });
  });

  it("builds ids matching `vitest list` format", () => {
    const tests = parseVitestJson(SAMPLE_VITEST_JSON, "npx vitest run");
    expect(tests[0]?.id).toBe(
      "tests/integration/story-001.test.ts > POST /api/reactions > creates a reaction"
    );
  });

  it("preserves the describe/it boundary when the test name contains ' > '", () => {
    // Regression: vitest's JSON reporter joins describe and it in `fullName`
    // with a single space; `vitest list` uses " > ". If a test title itself
    // contains " > " (e.g. "count > 0"), the old fullName-based path produced
    // an id missing the describe/it separator and caused MANIFEST_DRIFT on
    // every brew touching such a test. Build from ancestorTitles + title
    // so the separator is always correct.
    const withGt = JSON.stringify({
      testResults: [
        {
          name: "tests/integration/story-004-ui.test.tsx",
          assertionResults: [
            {
              fullName:
                "FeedPage (story-004 UI) appends '+N others' when other_reactor_count > 0",
              title: "appends '+N others' when other_reactor_count > 0",
              ancestorTitles: ["FeedPage (story-004 UI)"],
              status: "failed",
            },
          ],
        },
      ],
    });
    const tests = parseVitestJson(withGt, "npx vitest run");
    expect(tests[0]?.id).toBe(
      "tests/integration/story-004-ui.test.tsx > FeedPage (story-004 UI) > appends '+N others' when other_reactor_count > 0"
    );
  });

  it("returns empty array when stdout has no JSON object", () => {
    expect(parseVitestJson("no json here", "npx vitest run")).toEqual([]);
  });

  it("tolerates JSON preceded by stderr/log noise", () => {
    const noisy = `npm warn ...\nsome warning\n${SAMPLE_VITEST_JSON}`;
    const tests = parseVitestJson(noisy, "npx vitest run");
    expect(tests).toHaveLength(3);
  });

  it("maps skipped/pending/todo statuses to 'skipped'", () => {
    const withSkips = JSON.stringify({
      testResults: [
        {
          name: "tests/a.test.ts",
          assertionResults: [
            { fullName: "a > skip me", status: "skipped" },
            { fullName: "a > pending", status: "pending" },
            { fullName: "a > todo", status: "todo" },
          ],
        },
      ],
    });
    const tests = parseVitestJson(withSkips, "npx vitest run");
    expect(tests.every((t) => t.status === "skipped")).toBe(true);
  });

  it("maps unknown statuses to 'errored'", () => {
    const weird = JSON.stringify({
      testResults: [
        {
          name: "tests/a.test.ts",
          assertionResults: [{ fullName: "a > x", status: "weird" }],
        },
      ],
    });
    const tests = parseVitestJson(weird, "npx vitest run");
    expect(tests[0]?.status).toBe("errored");
  });

  it("uses cwd to compute repo-relative file paths when provided", () => {
    const input = JSON.stringify({
      testResults: [
        {
          name: "/home/runner/work/app/app/tests/integration/story-001.test.ts",
          assertionResults: [{ fullName: "x > y", status: "passed" }],
        },
      ],
    });
    const tests = parseVitestJson(input, "npx vitest run", {
      cwd: "/home/runner/work/app/app",
    });
    // Regression: without cwd, the old regex matched the first `/app/` and
    // produced `app/app/tests/integration/...`. With cwd we get the true
    // repo-relative path that matches what testgen writes into manifests.
    expect(tests[0]?.file).toBe("tests/integration/story-001.test.ts");
  });

  it("falls back to anchor regex when cwd is not provided", () => {
    const input = JSON.stringify({
      testResults: [
        {
          name: "/abs/repo/tests/integration/story-001.test.ts",
          assertionResults: [{ fullName: "x > y", status: "passed" }],
        },
      ],
    });
    const tests = parseVitestJson(input, "npx vitest run");
    expect(tests[0]?.file).toBe("tests/integration/story-001.test.ts");
  });
});

describe("runTests", () => {
  it("invokes each suite's run_command and aggregates results", () => {
    const calls: Array<{ cmd: string; cwd: string }> = [];
    const fakeExec = (cmd: string, cwd: string) => {
      calls.push({ cmd, cwd });
      return { stdout: SAMPLE_VITEST_JSON, stderr: "", code: 1 };
    };
    const result = runTests(mkConfig(), { cwd: "/tmp", exec: fakeExec });
    expect(result.ran).toBe(true);
    expect(calls[0]?.cmd).toContain("--reporter=json"); // auto-appended
    expect(result.tests).toHaveLength(3);
    expect(result.suites).toHaveLength(1);
    expect(result.suites[0]?.exit_code).toBe(1);
  });

  it("does NOT append --reporter=json if already present", () => {
    const calls: string[] = [];
    const fakeExec = (cmd: string) => {
      calls.push(cmd);
      return { stdout: SAMPLE_VITEST_JSON, stderr: "", code: 0 };
    };
    runTests(mkConfig("npx vitest run --reporter=json"), {
      cwd: "/tmp",
      exec: fakeExec,
    });
    expect(calls[0]).toBe("npx vitest run --reporter=json");
  });

  it("sets ran=false when no suite produced parsable JSON and exit was non-zero", () => {
    const fakeExec = () => ({ stdout: "fatal error", stderr: "boom", code: 1 });
    const result = runTests(mkConfig(), { cwd: "/tmp", exec: fakeExec });
    expect(result.ran).toBe(false);
    expect(result.error).toMatch(/no parsable JSON/);
    expect(result.tests).toEqual([]);
  });

  it("sets ran=true when exit is non-zero but JSON parses (tests ran, some failed)", () => {
    const fakeExec = () => ({ stdout: SAMPLE_VITEST_JSON, stderr: "", code: 1 });
    const result = runTests(mkConfig(), { cwd: "/tmp", exec: fakeExec });
    expect(result.ran).toBe(true);
  });

  it("returns empty result for a config with no suites", () => {
    const result = runTests({ language: "typescript" }, {
      cwd: "/tmp",
      exec: () => ({ stdout: "", stderr: "", code: 0 }),
    });
    expect(result.tests).toEqual([]);
    expect(result.suites).toEqual([]);
  });
});

describe("suite env reaches the runner", () => {
  it("passes declared env to exec and keeps it out of the command string", () => {
    const seen: (Record<string, string> | undefined)[] = [];
    const cmds: string[] = [];
    const cfg = mkConfig();
    cfg.test!["backend"]!.env = { TEST_MODE: "integration", SECRET_TOKEN: "hunter2" };
    runTests(cfg, {
      cwd: "/repo",
      exec: (cmd, _cwd, env) => {
        cmds.push(cmd);
        seen.push(env);
        return { stdout: SAMPLE_VITEST_JSON, stderr: "", code: 1 };
      },
    });
    expect(seen[0]).toEqual({ TEST_MODE: "integration", SECRET_TOKEN: "hunter2" });
    expect(cmds[0]).not.toContain("hunter2");
  });

  it("passes undefined when no env is declared", () => {
    const seen: (Record<string, string> | undefined)[] = [];
    runTests(mkConfig(), {
      cwd: "/repo",
      exec: (_cmd, _cwd, env) => {
        seen.push(env);
        return { stdout: SAMPLE_VITEST_JSON, stderr: "", code: 1 };
      },
    });
    expect(seen[0]).toBeUndefined();
  });
});

describe("tap-prove suites (pgTAP gating, 2026-08-22)", () => {
  const config = {
    language: "typescript" as const,
    package_manager: "npm" as const,
    test: {
      db: {
        runner: "pg_prove",
        run_command: "npx supabase test db",
        discover_command: "ls supabase/tests/database/*.test.sql",
        reporter_format: "tap-prove",
      },
    },
  };

  it("parses prove lines into per-file results, stripping the cwd prefix", () => {
    const stdout = [
      "/repo/supabase/tests/database/00-smoke.test.sql .. ok",
      "/repo/supabase/tests/database/story-019-merge-rewos.test.sql .. Dubious, test returned 3",
      "Test Summary Report",
      "story-019-merge-rewos.test.sql (Wstat: 768 Tests: 0 Failed: 0)",
    ].join("\n");
    const r = runTests(config as never, {
      cwd: "/repo",
      exec: () => ({ stdout, stderr: "", code: 1 }),
    });
    expect(r.tests).toHaveLength(2);
    expect(r.tests[0]).toMatchObject({
      file: "supabase/tests/database/00-smoke.test.sql",
      status: "passed",
    });
    expect(r.tests[1]!.status).toBe("failed");
    expect(r.tests[1]!.failure_message).toContain("Dubious");
  });

  it("nonzero exit with no parseable lines = suite error, not silence", () => {
    const r = runTests(config as never, {
      cwd: "/repo",
      exec: () => ({ stdout: "container exploded", stderr: "boom", code: 1 }),
    });
    expect(r.tests).toHaveLength(0);
    expect(r.error ?? "").not.toBe(undefined);
  });
});

describe("parsePlaywrightRunJson (2026-08-23)", () => {
  const doc = {
    config: { rootDir: "/root/rewo/tests/acceptance" },
    suites: [
      {
        title: "story-005.spec.ts",
        file: "story-005.spec.ts",
        specs: [],
        suites: [
          {
            title: "story-005 /u/<handle> — acceptance",
            file: "story-005.spec.ts",
            specs: [
              {
                title: "unauthenticated visit redirects to /login",
                file: "story-005.spec.ts",
                tests: [
                  {
                    projectName: "chromium-desktop",
                    status: "unexpected",
                    results: [{ status: "failed", error: { message: "expected /login got /u/x" } }],
                  },
                ],
              },
              {
                title: "Gate 1: /login page is clean at mobile viewport",
                file: "story-005.spec.ts",
                tests: [{ projectName: "chromium-desktop", status: "expected", results: [{ status: "passed" }] }],
              },
              {
                title: "unknown handle returns notFound UI",
                file: "story-005.spec.ts",
                tests: [{ projectName: "chromium-desktop", status: "skipped", results: [] }],
              },
            ],
          },
        ],
      },
    ],
  };

  it("produces ids identical to the list parser's shape (manifest ↔ runner agreement)", () => {
    const got = parsePlaywrightRunJson(JSON.stringify(doc));
    expect(got.map((t) => t.id)).toEqual([
      "tests/acceptance/story-005.spec.ts > story-005 /u/<handle> — acceptance > unauthenticated visit redirects to /login [chromium-desktop]",
      "tests/acceptance/story-005.spec.ts > story-005 /u/<handle> — acceptance > Gate 1: /login page is clean at mobile viewport [chromium-desktop]",
      "tests/acceptance/story-005.spec.ts > story-005 /u/<handle> — acceptance > unknown handle returns notFound UI [chromium-desktop]",
    ]);
  });

  it("maps aggregate statuses: unexpected→failed(+message), expected→passed, skipped→skipped", () => {
    const got = parsePlaywrightRunJson(JSON.stringify(doc));
    expect(got.map((t) => t.status)).toEqual(["failed", "passed", "skipped"]);
    expect(got[0]!.failure_message).toContain("expected /login got /u/x");
  });

  it("tolerates a log prefix before the JSON and returns [] on garbage", () => {
    expect(parsePlaywrightRunJson("booting webserver...\n" + JSON.stringify(doc))).toHaveLength(3);
    expect(parsePlaywrightRunJson("no json here")).toEqual([]);
  });

  it("flaky counts as passed (it eventually passed)", () => {
    const flaky = JSON.parse(JSON.stringify(doc)) as typeof doc;
    flaky.suites[0]!.suites![0]!.specs![0]!.tests![0]!.status = "flaky";
    const got = parsePlaywrightRunJson(JSON.stringify(flaky));
    expect(got[0]!.status).toBe("passed");
  });
});
