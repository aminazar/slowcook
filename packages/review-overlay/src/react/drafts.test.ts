// 0.14.0 — drafts survive a stray backdrop click; submit clears them.
import { describe, it, expect, beforeEach } from "vitest";
import { draftFor, saveDraft } from "./review-shell.js";

// node env: shim localStorage
const mem = new Map<string, string>();
(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (k: string) => mem.get(k) ?? null,
  setItem: (k: string, v: string) => void mem.set(k, v),
  removeItem: (k: string) => void mem.delete(k),
};

describe("composer drafts", () => {
  beforeEach(() => mem.clear());
  it("keeps text per anchor and restores it", () => {
    saveDraft("object/work_item", "half-typed thought");
    expect(draftFor("object/work_item")).toBe("half-typed thought");
    expect(draftFor("object/epic")).toBe("");
  });
  it("clears on empty save (submit path)", () => {
    saveDraft("n", "text");
    saveDraft("n", "");
    expect(draftFor("n")).toBe("");
  });
});
