import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadConstitution,
  constitutionBlock,
  initConstitution,
  addRuling,
  CONSTITUTION_PATH,
} from "./constitution.js";

function repo(): string {
  const r = mkdtempSync(join(tmpdir(), "constitution-"));
  mkdirSync(join(r, ".brewing"), { recursive: true });
  return r;
}

describe("constitution loader (S1, #526)", () => {
  it("absent file → null / empty block (callers append unconditionally)", () => {
    const r = repo();
    expect(loadConstitution(r)).toBeNull();
    expect(constitutionBlock(r)).toBe("");
  });

  it("empty file counts as absent — no preamble around nothing", () => {
    const r = repo();
    writeFileSync(join(r, CONSTITUTION_PATH), "  \n\n", "utf8");
    expect(loadConstitution(r)).toBeNull();
    expect(constitutionBlock(r)).toBe("");
  });

  it("present file → block carries the three-state enforcement preamble AND the verbatim content", () => {
    const r = repo();
    writeFileSync(
      join(r, CONSTITUTION_PATH),
      "## Slots\n- [x] RLS: members-read/service-write on new tables\n",
      "utf8"
    );
    const block = constitutionBlock(r);
    expect(block).toContain("supersedes informal practices");
    expect(block).toContain("deliberately blank");
    expect(block).toContain("do NOT flag");
    expect(block).toContain("RLS: members-read/service-write on new tables");
  });

  it("init writes the template once and refuses overwrite", () => {
    const r = repo();
    const first = initConstitution(r);
    expect(first.created).toBe(true);
    const body = readFileSync(join(r, CONSTITUTION_PATH), "utf8");
    expect(body).toContain("Spec Kit");
    expect(body).toContain("## Slots");
    expect(body).toContain("## Rulings");
    writeFileSync(join(r, CONSTITUTION_PATH), body + "- custom line\n", "utf8");
    const second = initConstitution(r);
    expect(second.created).toBe(false);
    expect(readFileSync(join(r, CONSTITUTION_PATH), "utf8")).toContain("- custom line");
  });

  it("addRuling appends date/by/verbatim/source and requires the file", () => {
    const r = repo();
    expect(() =>
      addRuling({ repoRoot: r, text: "x", by: "amin" })
    ).toThrow(/rule init/);
    initConstitution(r);
    const line = addRuling({
      repoRoot: r,
      text: "the endpoint owner's shipped contract wins",
      source: "reworthy/app#236",
      by: "amin",
      now: () => new Date(Date.UTC(2026, 7, 27)),
    });
    expect(line).toBe(
      '- 2026-08-27 (amin): "the endpoint owner\'s shipped contract wins" — reworthy/app#236'
    );
    const body = readFileSync(join(r, CONSTITUTION_PATH), "utf8");
    expect(body.endsWith(line + "\n")).toBe(true);
  });
});
