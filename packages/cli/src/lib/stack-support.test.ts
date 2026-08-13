// dovizir handover §8 — testgen emitted a vitest .test.ts into a Solidity
// project. The configured runner (forge) can never discover it, so the
// operator gets a green command, a committed file, and a confusing failure
// much later. Refusing is the honest v1.
import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  declaredLanguage,
  isTsLanguage,
  unsupportedStackMessage,
} from "./stack-support.js";

let repo: string;
beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "sc-stack-"));
  mkdirSync(join(repo, ".brewing"), { recursive: true });
});

function writeStack(body: unknown): void {
  writeFileSync(join(repo, ".brewing", "stack.json"), JSON.stringify(body), "utf8");
}

describe("declaredLanguage", () => {
  it("reads the declared language", () => {
    writeStack({ language: "solidity" });
    expect(declaredLanguage(repo)).toBe("solidity");
  });

  it("normalizes case and whitespace", () => {
    writeStack({ language: "  Solidity " });
    expect(declaredLanguage(repo)).toBe("solidity");
  });

  it("is null when there is no stack.json, or it is unreadable", () => {
    expect(declaredLanguage(repo)).toBeNull();
    writeFileSync(join(repo, ".brewing", "stack.json"), "{ not json", "utf8");
    expect(declaredLanguage(repo)).toBeNull();
  });

  it("is null when language is missing or empty", () => {
    writeStack({ package_manager: "pnpm" });
    expect(declaredLanguage(repo)).toBeNull();
  });
});

describe("isTsLanguage", () => {
  it("accepts ts/js", () => {
    expect(isTsLanguage("typescript")).toBe(true);
    expect(isTsLanguage("javascript")).toBe(true);
  });

  it("accepts null — a repo with no stack.json asserts nothing, so don't block it", () => {
    expect(isTsLanguage(null)).toBe(true);
  });

  it("rejects other stacks", () => {
    expect(isTsLanguage("solidity")).toBe(false);
    expect(isTsLanguage("python")).toBe(false);
  });
});

describe("unsupportedStackMessage", () => {
  it("names the language, the reason, and what to do instead", () => {
    const msg = unsupportedStackMessage("testgen", "solidity");
    expect(msg).toContain("solidity");
    expect(msg).toContain("testgen");
    // the crux: says WHY refusing beats emitting
    expect(msg).toContain("can never discover");
    expect(msg).toContain("manifest record");
  });
});
