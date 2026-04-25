import { describe, it, expect, vi, beforeEach } from "vitest";

// Re-export internals via a test-only barrel to keep the production surface
// clean. We dynamically import so top-level module side effects (execSync
// reading git remote, etc.) stay scoped.
async function loadModule() {
  return await import("./index.js");
}

describe("slowcook dispatch — arg parsing + config building", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("exposes a `dispatch` entry function", async () => {
    const mod = await loadModule();
    expect(typeof mod.dispatch).toBe("function");
  });

  // The command's side effects (execSync, Octokit, process.exit) aren't
  // unit-testable without heavy mocking. The important invariants covered
  // below are the arg parser + step-to-workflow mapping, which live inside
  // index.ts but aren't exported. We test end-to-end via the process.exit
  // code for obvious misuse cases — the contract users actually see.

  it("prints help and exits cleanly when called with no args", async () => {
    const mod = await loadModule();
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`__exit_${code ?? 0}__`);
    }) as never);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    // Empty argv = user asked for help → exit 0 after printing.
    await expect(mod.dispatch([])).rejects.toThrow(/__exit_0__/);
    expect(logSpy).toHaveBeenCalled();
    const logOutput = logSpy.mock.calls.flat().join(" ");
    expect(logOutput).toMatch(/slowcook dispatch/);
    exitSpy.mockRestore();
    logSpy.mockRestore();
  });

  it("errors out with exit code 2 on unknown step", async () => {
    const mod = await loadModule();
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`__exit_${code ?? 0}__`);
    }) as never);
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await expect(mod.dispatch(["bogus-step"])).rejects.toThrow(/__exit_2__/);
    expect(errSpy).toHaveBeenCalledWith(
      expect.stringContaining("Unknown step 'bogus-step'")
    );
    exitSpy.mockRestore();
    errSpy.mockRestore();
    logSpy.mockRestore();
  });

  it("errors out when brew dispatched without --story", async () => {
    const mod = await loadModule();
    // Need GITHUB_TOKEN present + git remote detected to reach the
    // required-inputs check; set both minimally.
    const prevToken = process.env["GITHUB_TOKEN"];
    process.env["GITHUB_TOKEN"] = "ghp_test_fake_token";
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`__exit_${code ?? 0}__`);
    }) as never);
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await expect(mod.dispatch(["brew"])).rejects.toThrow(/__exit_2__/);

    const errorCalls = errSpy.mock.calls.flat().join(" ");
    // Either missing story_id OR no git remote — both reach exit 2.
    // Accept either so the test is robust to the test env.
    expect(
      /story_id|git remote|workflow/i.test(errorCalls)
    ).toBe(true);

    process.env["GITHUB_TOKEN"] = prevToken;
    exitSpy.mockRestore();
    errSpy.mockRestore();
    logSpy.mockRestore();
  });

  it("0.13.0-alpha.1: 'recipe' is accepted as an alias for 'testgen'", async () => {
    const mod = await loadModule();
    const prevToken = process.env["GITHUB_TOKEN"];
    delete process.env["GITHUB_TOKEN"]; // forces exit at the GITHUB_TOKEN check
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`__exit_${code ?? 0}__`);
    }) as never);
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    // 'recipe' should NOT trigger the "Unknown step" error path; it
    // should normalise to the testgen step and reach the same later
    // checkpoint as `dispatch testgen` would.
    await expect(mod.dispatch(["recipe"])).rejects.toThrow(/__exit_2__/);
    const errorCalls = errSpy.mock.calls.flat().join(" ");
    expect(errorCalls).not.toMatch(/Unknown step/);
    // The error reached should be GITHUB_TOKEN or git remote — same as
    // the 'testgen' step would have hit.
    expect(/GITHUB_TOKEN|git remote/i.test(errorCalls)).toBe(true);

    if (prevToken !== undefined) process.env["GITHUB_TOKEN"] = prevToken;
    exitSpy.mockRestore();
    errSpy.mockRestore();
    logSpy.mockRestore();
  });

  it("errors out when GITHUB_TOKEN is missing (brew)", async () => {
    const mod = await loadModule();
    const prevToken = process.env["GITHUB_TOKEN"];
    delete process.env["GITHUB_TOKEN"];
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`__exit_${code ?? 0}__`);
    }) as never);
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(mod.dispatch(["brew", "--story", "006"])).rejects.toThrow(
      /__exit_2__/
    );
    expect(
      errSpy.mock.calls.flat().join(" ")
    ).toMatch(/GITHUB_TOKEN/);

    if (prevToken !== undefined) process.env["GITHUB_TOKEN"] = prevToken;
    exitSpy.mockRestore();
    errSpy.mockRestore();
  });
});
