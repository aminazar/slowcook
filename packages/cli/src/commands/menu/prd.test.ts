import { describe, it, expect } from "vitest";
import { parsePrdInitiatives, slugify } from "./prd.js";

describe("slugify (GitHub anchor rules)", () => {
  it("lowercases, hyphenates spaces, drops punctuation", () => {
    expect(slugify("User Login & Auth")).toBe("user-login-auth");
    expect(slugify("  Spaced  Out  ")).toBe("spaced-out");
    expect(slugify("Already-hyphen")).toBe("already-hyphen");
  });
});

describe("parsePrdInitiatives", () => {
  it("extracts each heading as an anchored initiative with its body", () => {
    const md = `# Product
intro line

## Onboarding
Users sign up.
More detail.

## Dashboard
Shows tickets.`;
    const inits = parsePrdInitiatives(md);
    expect(inits.map((i) => i.anchor)).toEqual(["product", "onboarding", "dashboard"]);
    expect(inits[1]).toMatchObject({ title: "Onboarding", level: 2 });
    expect(inits[1]!.body).toBe("Users sign up.\nMore detail.");
    expect(inits[2]!.body).toBe("Shows tickets.");
  });

  it("honors an explicit {#custom-anchor}", () => {
    const inits = parsePrdInitiatives("## Patient Onboarding {#onboarding-v1}\nbody");
    expect(inits[0]).toMatchObject({ anchor: "onboarding-v1", title: "Patient Onboarding" });
  });

  it("ignores `#` inside fenced code blocks", () => {
    const md = `## Real Heading
\`\`\`bash
# this is a shell comment, not a heading
echo hi
\`\`\`
after`;
    const inits = parsePrdInitiatives(md);
    expect(inits).toHaveLength(1);
    expect(inits[0]!.anchor).toBe("real-heading");
    expect(inits[0]!.body).toContain("# this is a shell comment");
  });

  it("returns [] for a PRD with no headings", () => {
    expect(parsePrdInitiatives("just prose, no headings")).toEqual([]);
  });

  it("captures nested headings as their own initiatives", () => {
    const inits = parsePrdInitiatives("# A\n## A1\nx\n### A1a\ny");
    expect(inits.map((i) => `${i.level}:${i.anchor}`)).toEqual(["1:a", "2:a1", "3:a1a"]);
  });
});
