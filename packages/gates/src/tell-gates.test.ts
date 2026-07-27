// The storyteller gates' pure classifiers — domain-neutral fixtures with a
// deliberately bloated button, a leaked explanation, and an off-brand page.
import { describe, it, expect } from "vitest";
import { classifyButtonLabel } from "./button-doctrine.js";
import { classifyVoice } from "./voice.js";
import { classifyBrand } from "./brand-presence.js";

describe("button doctrine", () => {
  const f = (label: string, hasPriceTag = false) => ({ selector: "[data-affordance=\"x\"]", label, hasPriceTag });

  it("passes a short verb", () => {
    expect(classifyButtonLabel(f("Save"))).toEqual([]);
    expect(classifyButtonLabel(f("Send invite"))).toEqual([]);
  });
  it("fails the deliberately bloated button", () => {
    const v = classifyButtonLabel(f("top up exactly $5.30 — finishes the whole thing at p85"));
    expect(v.some((x) => x.evidence.includes("words"))).toBe(true);
    expect(v.some((x) => x.evidence.includes("money in the label"))).toBe(true);
  });
  it("money never rides inside the act — even via the price tag (no.615)", () => {
    expect(classifyButtonLabel(f("Top up", true))).toHaveLength(1);
    expect(classifyButtonLabel(f("Top up"))).toEqual([]);
    expect(classifyButtonLabel(f("Pay $5"))).toHaveLength(1);
  });
  it("fails sentences and empty labels", () => {
    expect(classifyButtonLabel(f("Click here to continue."))).not.toEqual([]);
    expect(classifyButtonLabel(f(""))).toHaveLength(1);
  });
});

describe("voice", () => {
  it("flags leaked stage vocabulary and long explainers; passes product copy", () => {
    const v = classifyVoice({ blocks: [
      { selector: "p", text: "This wireframe shows the checkout." },
      { selector: "p", text: "x".repeat(300) },
      { selector: "p", text: "3 items · ready to ship" },
    ] });
    expect(v).toHaveLength(2);
    expect(v[0]!.evidence).toContain("banned vocabulary");
    expect(v[1]!.evidence).toContain("explanatory block");
  });
  it("consumer-extends the banned list without any built-in product words", () => {
    const v = classifyVoice({ blocks: [{ selector: "p", text: "the gadget flux is stale" }] }, { banned: ["\\bgadget flux\\b"] });
    expect(v).toHaveLength(1);
  });
});

describe("brand presence", () => {
  it("fails the off-brand page and passes a tokened one", () => {
    expect(classifyBrand({ tokenCount: 0, bodyFont: "Times", distinctColors: 2 })).toHaveLength(3);
    expect(classifyBrand({ tokenCount: 14, bodyFont: '"Inter", sans-serif', distinctColors: 9 })).toEqual([]);
  });
});
