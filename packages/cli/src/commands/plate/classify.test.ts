import { describe, it, expect } from "vitest";
import { classifyComment, extractSpecTerms } from "./classify.js";

const story017Spec = `story_id: "017"
title: Pinned rewos strip
status: active
ui_behavior:
  desktop_light: "On /u/:handle, render a pinned strip above the reactions list."
  mobile_light: "1.2-card peek on mobile."
acceptance_scenarios:
  - "Given the user has 3 pinned rewos, When viewing /u/amin, Then the pinned strip shows 3 cards above the reactions list."
  - "Given the user clicks Pin on a reaction card, When the click resolves, Then the pinned strip prepends that rewo and the Pin button switches to Pinned."
invariants:
  - "Pin count never exceeds 12 per member."
api_contract:
  GET /api/profiles/:handle/pins:
    response:
      pins:
        - { id: string, member_id: string, rewo_id: string, pinned_at: string }
`;

describe("extractSpecTerms", () => {
  it("includes domain nouns from acceptance + ui_behavior + api_contract", () => {
    const terms = extractSpecTerms(story017Spec);
    expect(terms).toContain("pinned");
    expect(terms).toContain("strip");
    expect(terms).toContain("reactions");
    expect(terms).toContain("pins");
    expect(terms).toContain("member_id");
    expect(terms).toContain("rewo_id");
  });

  it("filters obvious stopwords", () => {
    const terms = extractSpecTerms(story017Spec);
    expect(terms).not.toContain("the");
    expect(terms).not.toContain("when");
    expect(terms).not.toContain("then");
  });

  it("returns an empty list when none of the relevant sections exist", () => {
    const terms = extractSpecTerms(`story_id: "099"
title: backend cron
`);
    expect(terms).toEqual([]);
  });
});

describe("classifyComment", () => {
  it("classifies pure-color feedback as cosmetic", () => {
    const r = classifyComment({
      prose: "The Pinned button background should be coral, not green.",
      specYaml: story017Spec,
    });
    // "pinned" + "button" — but no structural verb, so cosmetic wins
    expect(r.classification).toBe("cosmetic");
    expect(r.rationale).toContain("Style-only");
  });

  it("classifies padding feedback as cosmetic", () => {
    const r = classifyComment({
      prose: "Padding feels cramped vertically; bump it up.",
      specYaml: story017Spec,
    });
    expect(r.classification).toBe("cosmetic");
  });

  it("classifies font/spacing feedback as cosmetic", () => {
    const r = classifyComment({
      prose: "Font size on the badge is too small; tighten the gap.",
      specYaml: story017Spec,
    });
    expect(r.classification).toBe("cosmetic");
  });

  it("classifies remove-the-strip as spec-altering (structural verb + spec term)", () => {
    const r = classifyComment({
      prose: "Actually, let's remove the pinned strip entirely on mobile.",
      specYaml: story017Spec,
    });
    expect(r.classification).toBe("spec-altering");
    expect(r.rationale).toContain("remove");
    expect(r.matchedSpecTerms).toContain("pinned");
  });

  it("classifies replace-X-with-Y as spec-altering", () => {
    const r = classifyComment({
      prose: "Replace pinned with bookmarked in the strip header.",
      specYaml: story017Spec,
    });
    expect(r.classification).toBe("spec-altering");
    expect(r.rationale).toContain("replace");
  });

  it("classifies add-a-new-spec-thing as spec-altering", () => {
    const r = classifyComment({
      prose: "Add an unpin button on each strip card too.",
      specYaml: story017Spec,
    });
    expect(r.classification).toBe("spec-altering");
  });

  it("classifies mock-shows-X-but-spec-says-Y as mock-divergence", () => {
    const r = classifyComment({
      prose: "The pinned strip currently shows 5 cards but spec says 3.",
      specYaml: story017Spec,
    });
    // Spec terms present (pinned, strip), no structural verb
    expect(r.classification).toBe("mock-divergence");
    expect(r.matchedSpecTerms).toContain("pinned");
  });

  it("falls through to mock-divergence when prose has no clear signal", () => {
    const r = classifyComment({
      prose: "Hmm — looks weird.",
      specYaml: story017Spec,
    });
    // No structural verb, no cosmetic word, no spec term match.
    expect(r.classification).toBe("mock-divergence");
  });

  it("conservative: cosmetic-LIKE prose with a structural verb on a spec term still escalates", () => {
    const r = classifyComment({
      prose: "The badge color is fine — but please remove the pinned strip on mobile.",
      specYaml: story017Spec,
    });
    expect(r.classification).toBe("spec-altering");
  });

  it("matchedSpecTerms is empty for cosmetic-only comments", () => {
    const r = classifyComment({
      prose: "Just bump the font weight a notch.",
      specYaml: story017Spec,
    });
    expect(r.matchedSpecTerms).toEqual([]);
  });

  it("classifies styling on a spec-named element as cosmetic", () => {
    const r = classifyComment({
      prose: "Use the secondary background tint for the strip card.",
      specYaml: story017Spec,
    });
    // "background" is cosmetic, "strip" is a spec term — but no
    // structural verb means the PM is just styling the element by
    // its semantic name. Cosmetic wins; rationale notes the spec
    // term so plate's prompt still has the context.
    expect(r.classification).toBe("cosmetic");
    expect(r.matchedSpecTerms).toContain("strip");
    expect(r.rationale).toContain("strip");
  });
});
