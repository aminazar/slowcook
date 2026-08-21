import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadGates, GATE_DEFAULTS } from "./gates.js";

describe("loadGates", () => {
  it("defaults: spec/tests agent-mergeable; brew/vibe/eye human", () => {
    expect(GATE_DEFAULTS).toEqual({
      spec: "agent",
      tests: "agent",
      brew: "human",
      vibe: "human",
      eye: "human",
    });
    expect(loadGates(mkdtempSync(join(tmpdir(), "gates-")))).toEqual(GATE_DEFAULTS);
  });

  it("reads declared gates and ignores invalid values (never fail open)", () => {
    const r = mkdtempSync(join(tmpdir(), "gates-"));
    mkdirSync(join(r, ".brewing"));
    writeFileSync(
      join(r, ".brewing", "gates.yaml"),
      "gates:\n  spec: human\n  tests: agent\n  brew: banana\n"
    );
    const g = loadGates(r);
    expect(g.spec).toBe("human");
    expect(g.tests).toBe("agent");
    expect(g.brew).toBe("human"); // invalid value -> conservative default
    expect(g.vibe).toBe("human");
  });
});
