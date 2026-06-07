import { describe, it, expect } from "vitest";
import { extractFidelityModes } from "./spec-modes.js";

describe("extractFidelityModes", () => {
  it("reads fidelity.modes from a spec", () => {
    const yaml = `story_id: "020"\nfidelity:\n  modes: [light, dark, mobile]\n`;
    expect(extractFidelityModes(yaml)).toEqual(["light", "dark", "mobile"]);
  });

  it("returns null when fidelity is absent", () => {
    expect(extractFidelityModes(`story_id: "020"\ntitle: x\n`)).toBeNull();
  });

  it("returns null when fidelity has no modes array", () => {
    expect(extractFidelityModes(`fidelity:\n  notes: dark matters\n`)).toBeNull();
  });

  it("coerces non-string mode entries to strings", () => {
    expect(extractFidelityModes(`fidelity:\n  modes:\n    - dark\n    - 2\n`)).toEqual(["dark", "2"]);
  });

  it("returns null on malformed yaml rather than throwing", () => {
    expect(extractFidelityModes(`fidelity:\n  modes: [unterminated\n`)).toBeNull();
  });
});
