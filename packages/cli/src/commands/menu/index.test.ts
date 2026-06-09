import { describe, it, expect } from "vitest";
import { extractStories } from "./index.js";

describe("extractStories (agent reply → drafts)", () => {
  it("parses a bare JSON object", () => {
    const out = extractStories('{"stories":[{"title":"A"},{"title":"B"}]}');
    expect(out.map((s) => s.title)).toEqual(["A", "B"]);
  });

  it("tolerates a ```json fenced block + surrounding prose", () => {
    const text = 'Here you go:\n```json\n{"stories":[{"title":"X"}]}\n```\nDone.';
    expect(extractStories(text).map((s) => s.title)).toEqual(["X"]);
  });

  it("returns [] when stories key is absent but JSON parses", () => {
    expect(extractStories('{"other":1}')).toEqual([]);
  });

  it("throws when there is no JSON object", () => {
    expect(() => extractStories("no json here")).toThrow(/no JSON object/);
  });
});
