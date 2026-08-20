import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pmHandles, ccLine } from "./pm-notify.js";

function repo(): string {
  return mkdtempSync(join(tmpdir(), "pmnotify-"));
}

describe("pmHandles", () => {
  it("prefers stack.json pm list and normalizes bare handles", () => {
    const r = repo();
    mkdirSync(join(r, ".brewing"));
    writeFileSync(
      join(r, ".brewing", "stack.json"),
      JSON.stringify({ pm: ["aminazar", "@hpezeshki"] })
    );
    writeFileSync(join(r, "CODEOWNERS"), "* @someone-else\n");
    expect(pmHandles(r)).toEqual(["@aminazar", "@hpezeshki"]);
  });

  it("falls back to the CODEOWNERS default rule, skipping comments", () => {
    const r = repo();
    writeFileSync(
      join(r, "CODEOWNERS"),
      "# CODEOWNERS for rewo\n#\n# Default owner: @aminazar owns everything.\n* @aminazar\n"
    );
    expect(pmHandles(r)).toEqual(["@aminazar"]);
  });

  it("reads .github/CODEOWNERS too", () => {
    const r = repo();
    mkdirSync(join(r, ".github"));
    writeFileSync(join(r, ".github", "CODEOWNERS"), "* @org/team @lead\n");
    expect(pmHandles(r)).toEqual(["@org/team", "@lead"]);
  });

  it("returns empty when nothing declares an owner — never invents a mention", () => {
    expect(pmHandles(repo())).toEqual([]);
  });
});

describe("ccLine", () => {
  it("renders a cc suffix, or nothing at all", () => {
    expect(ccLine(["@a", "@b"])).toBe("\n\ncc @a @b");
    expect(ccLine([])).toBe("");
  });
});
