import { describe, it, expect } from "vitest";
import {
  buildPlan,
  detectStack,
  InitError,
  type FileReader,
  type PackageJson,
} from "./plan.js";
import {
  SLOWCOOK_CODEOWNERS_MARKER_BEGIN,
  SLOWCOOK_CODEOWNERS_MARKER_END,
} from "./templates.js";

/** Minimal in-memory FileReader for testing. */
function mkReader(files: Record<string, string>): FileReader {
  return {
    exists: (p: string) => p in files || Object.keys(files).some((k) => k === p.replace(/\/$/, "")),
    read: (p: string) => {
      const v = files[p];
      if (v === undefined) throw new Error(`no such file in test reader: ${p}`);
      return v;
    },
  };
}

const MIN_PKG: PackageJson = {
  devDependencies: { vitest: "^2.0.0" },
};

describe("detectStack", () => {
  it("flags vitest in devDependencies", () => {
    expect(detectStack({ devDependencies: { vitest: "^2" } })).toMatchObject({
      hasVitest: true,
      hasPlaywright: false,
    });
  });

  it("flags vitest in dependencies too", () => {
    expect(detectStack({ dependencies: { vitest: "^2" } })).toMatchObject({
      hasVitest: true,
    });
  });

  it("detects @playwright/test", () => {
    expect(
      detectStack({ devDependencies: { "@playwright/test": "^1" } })
    ).toMatchObject({ hasPlaywright: true });
  });

  it("detects bare 'playwright' package too", () => {
    expect(detectStack({ devDependencies: { playwright: "^1" } })).toMatchObject({
      hasPlaywright: true,
    });
  });

  it("reports neither for a plain project", () => {
    expect(detectStack({})).toEqual({
      language: "typescript",
      hasVitest: false,
      hasPlaywright: false,
    });
  });
});

describe("buildPlan — fresh project", () => {
  it("errors when package.json is missing", () => {
    const reader = mkReader({});
    expect(() =>
      buildPlan(reader, { cwd: "/repo", owner: "@u", force: false })
    ).toThrow(InitError);
  });

  it("errors when package.json is invalid JSON", () => {
    const reader = mkReader({ "package.json": "{not json" });
    expect(() =>
      buildPlan(reader, { cwd: "/repo", owner: "@u", force: false })
    ).toThrow(/not valid JSON/);
  });

  it("errors when vitest is not detected", () => {
    const reader = mkReader({ "package.json": JSON.stringify({}) });
    expect(() =>
      buildPlan(reader, { cwd: "/repo", owner: "@u", force: false })
    ).toThrow(/Vitest/);
  });

  it("plans to create all targets on a clean repo", () => {
    const reader = mkReader({ "package.json": JSON.stringify(MIN_PKG) });
    const plan = buildPlan(reader, { cwd: "/repo", owner: "@u", force: false });
    const paths = plan.actions.map((a) => a.path);
    expect(paths).toContain(".brewing/frozen-paths.json");
    expect(paths).toContain(".brewing/stack.json");
    expect(paths).toContain(".brewing/README.md");
    expect(paths).toContain(".brewing/context.md");
    expect(paths).toContain(".brewing/manifests/.gitkeep");
    expect(paths).toContain(".github/workflows/slowcook.yml");
    expect(paths).toContain(".github/workflows/slowcook-spec-merged.yml");
    expect(paths).toContain(".github/workflows/slowcook-investigate.yml");
    expect(paths).toContain(".github/workflows/slowcook-sift.yml");
    expect(paths).toContain("CODEOWNERS");
    expect(plan.actions.every((a) => a.kind === "create")).toBe(true);
  });

  it("emits a warning when Playwright is detected (but still doesn't include e2e suite)", () => {
    const reader = mkReader({
      "package.json": JSON.stringify({
        devDependencies: { vitest: "^2", "@playwright/test": "^1" },
      }),
    });
    const plan = buildPlan(reader, { cwd: "/repo", owner: "@u", force: false });
    expect(plan.warnings).toHaveLength(1);
    expect(plan.warnings[0]).toMatch(/Playwright/i);
    // stack.json should NOT contain an e2e suite
    const stackAction = plan.actions.find((a) => a.path === ".brewing/stack.json");
    expect(stackAction).toBeDefined();
    if (stackAction && "contents" in stackAction) {
      const stack = JSON.parse(stackAction.contents);
      expect(stack.test).toHaveProperty("backend");
      expect(stack.test).not.toHaveProperty("e2e");
    }
  });

  it("embeds the owner in CODEOWNERS content", () => {
    const reader = mkReader({ "package.json": JSON.stringify(MIN_PKG) });
    const plan = buildPlan(reader, { cwd: "/repo", owner: "@acme/frontend", force: false });
    const co = plan.actions.find((a) => a.path === "CODEOWNERS");
    expect(co).toBeDefined();
    if (co && "contents" in co) {
      expect(co.contents).toContain("@acme/frontend");
      expect(co.contents).toContain(SLOWCOOK_CODEOWNERS_MARKER_BEGIN);
      expect(co.contents).toContain(SLOWCOOK_CODEOWNERS_MARKER_END);
    }
  });

  it("writes the cliVersion into .brewing/slowcook-cli-version (the single-source-of-truth pin)", () => {
    const reader = mkReader({ "package.json": JSON.stringify(MIN_PKG) });
    const plan = buildPlan(reader, {
      cwd: "/repo",
      owner: "@u",
      force: false,
      cliVersion: "0.7.0",
    });
    const pin = plan.actions.find((a) => a.path === ".brewing/slowcook-cli-version");
    expect(pin).toBeDefined();
    if (pin && "contents" in pin) {
      expect(pin.contents.trim()).toBe("0.7.0");
    }
  });

  it("CI workflow reads from the pin file (no inline version), and map check runs", () => {
    const reader = mkReader({ "package.json": JSON.stringify(MIN_PKG) });
    const plan = buildPlan(reader, {
      cwd: "/repo",
      owner: "@u",
      force: false,
      cliVersion: "0.7.0",
    });
    const wf = plan.actions.find((a) => a.path === ".github/workflows/slowcook.yml");
    expect(wf).toBeDefined();
    if (wf && "contents" in wf) {
      // Workflow must NOT carry an inline pin (prevents drift vs the file)
      expect(wf.contents).not.toContain("@slowcook-ai/cli@0.7.0");
      // Workflow must read from the pin file
      expect(wf.contents).toContain("cat .brewing/slowcook-cli-version");
      // Workflow must run map check (0.6.9 adds the code-map gate)
      expect(wf.contents).toContain("map check");
    }
  });
});

describe("buildPlan — existing files", () => {
  const PKG = JSON.stringify(MIN_PKG);

  it("skips-exists when file already matches template exactly", () => {
    // Build once to grab the expected content
    const r1 = mkReader({ "package.json": PKG });
    const plan1 = buildPlan(r1, { cwd: "/r", owner: "@u", force: false });
    const frozen = plan1.actions.find((a) => a.path === ".brewing/frozen-paths.json");
    expect(frozen).toBeDefined();
    if (!frozen || !("contents" in frozen)) return;

    // Now pretend that file exists with the same content
    const r2 = mkReader({
      "package.json": PKG,
      ".brewing/frozen-paths.json": frozen.contents,
    });
    const plan2 = buildPlan(r2, { cwd: "/r", owner: "@u", force: false });
    const redo = plan2.actions.find((a) => a.path === ".brewing/frozen-paths.json");
    expect(redo?.kind).toBe("skip-exists");
    if (redo?.kind === "skip-exists") {
      expect(redo.reason).toMatch(/already matches/i);
    }
  });

  it("skips-exists when file differs and --force is not set", () => {
    const reader = mkReader({
      "package.json": PKG,
      ".brewing/frozen-paths.json": `{"something": "else"}`,
    });
    const plan = buildPlan(reader, { cwd: "/r", owner: "@u", force: false });
    const a = plan.actions.find((x) => x.path === ".brewing/frozen-paths.json");
    expect(a?.kind).toBe("skip-exists");
    if (a?.kind === "skip-exists") {
      expect(a.reason).toMatch(/use --force/);
    }
  });

  it("overwrites when file differs and --force is set", () => {
    const reader = mkReader({
      "package.json": PKG,
      ".brewing/frozen-paths.json": `{"something": "else"}`,
    });
    const plan = buildPlan(reader, { cwd: "/r", owner: "@u", force: true });
    const a = plan.actions.find((x) => x.path === ".brewing/frozen-paths.json");
    expect(a?.kind).toBe("overwrite");
  });
});

describe("buildPlan — CODEOWNERS handling", () => {
  const PKG = JSON.stringify(MIN_PKG);

  it("appends our section when CODEOWNERS exists without our markers", () => {
    const existing = "# Existing content\n* @someone\n";
    const reader = mkReader({
      "package.json": PKG,
      CODEOWNERS: existing,
    });
    const plan = buildPlan(reader, { cwd: "/r", owner: "@u", force: false });
    const co = plan.actions.find((a) => a.path === "CODEOWNERS");
    expect(co?.kind).toBe("append");
    if (co?.kind === "append") {
      expect(co.contents).toContain("# Existing content");
      expect(co.contents).toContain("* @someone");
      expect(co.contents).toContain(SLOWCOOK_CODEOWNERS_MARKER_BEGIN);
      expect(co.contents).toContain(SLOWCOOK_CODEOWNERS_MARKER_END);
      expect(co.contents).toContain("@u");
    }
  });

  it("skips-exists when CODEOWNERS already has our markers", () => {
    const withOurs = `# old stuff\n* @x\n\n${SLOWCOOK_CODEOWNERS_MARKER_BEGIN}\n/tests/ @x\n${SLOWCOOK_CODEOWNERS_MARKER_END}\n`;
    const reader = mkReader({ "package.json": PKG, CODEOWNERS: withOurs });
    const plan = buildPlan(reader, { cwd: "/r", owner: "@u", force: false });
    const co = plan.actions.find((a) => a.path === "CODEOWNERS");
    expect(co?.kind).toBe("skip-exists");
    if (co?.kind === "skip-exists") {
      expect(co.reason).toMatch(/already present/);
    }
  });

  it("replaces our section inline when markers exist and --force is set", () => {
    const oldOurs = `# header\n* @x\n\n${SLOWCOOK_CODEOWNERS_MARKER_BEGIN}\nOLD CONTENT\n${SLOWCOOK_CODEOWNERS_MARKER_END}\n\n# trailing\n`;
    const reader = mkReader({ "package.json": PKG, CODEOWNERS: oldOurs });
    const plan = buildPlan(reader, { cwd: "/r", owner: "@new", force: true });
    const co = plan.actions.find((a) => a.path === "CODEOWNERS");
    expect(co?.kind).toBe("overwrite");
    if (co?.kind === "overwrite") {
      expect(co.contents).toContain("# header");
      expect(co.contents).toContain("@new");
      expect(co.contents).toContain("# trailing");
      expect(co.contents).not.toContain("OLD CONTENT");
    }
  });
});
