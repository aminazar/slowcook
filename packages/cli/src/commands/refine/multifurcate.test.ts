import { describe, it, expect } from "vitest";
import {
  parseMultifurcationJson,
  multifurcationCommentBody,
  hasExistingMultifurcationComment,
} from "./multifurcate.js";

describe("parseMultifurcationJson", () => {
  it("parses a clean ONE verdict", () => {
    const v = parseMultifurcationJson(
      JSON.stringify({ verdict: "one", rationale: "Single bounded outcome." })
    );
    expect(v).toEqual({ kind: "one", rationale: "Single bounded outcome." });
  });

  it("parses a clean MANY verdict + sub-issues", () => {
    const v = parseMultifurcationJson(
      JSON.stringify({
        verdict: "many",
        rationale: "Two apps, two roles, multiple flows.",
        sub_issues: [
          { title: "Patient login uses real auth", summary: "Members can log into the patient app." },
          {
            title: "Patient appointment list shows real bookings",
            summary: "Patients see their actual bookings.",
            depends_on: ["Patient login uses real auth"],
          },
        ],
      })
    );
    expect(v.kind).toBe("many");
    if (v.kind === "many") {
      expect(v.sub_issues).toHaveLength(2);
      expect(v.sub_issues[1]!.depends_on).toEqual(["Patient login uses real auth"]);
    }
  });

  it("strips ```json fences", () => {
    const wrapped = '```json\n{"verdict":"one","rationale":"yes"}\n```';
    const v = parseMultifurcationJson(wrapped);
    expect(v).toEqual({ kind: "one", rationale: "yes" });
  });

  it("falls back to ONE when MANY produces fewer than 2 valid sub-issues", () => {
    const v = parseMultifurcationJson(
      JSON.stringify({
        verdict: "many",
        rationale: "x",
        sub_issues: [{ title: "only one" /* no summary */ }],
      })
    );
    expect(v.kind).toBe("one");
    expect((v as { rationale: string }).rationale).toMatch(/parser fallback/);
  });

  it("falls back to ONE on malformed JSON", () => {
    expect(parseMultifurcationJson("not json at all").kind).toBe("one");
    expect(parseMultifurcationJson("").kind).toBe("one");
  });

  it("tolerates leading prose before the JSON object", () => {
    const v = parseMultifurcationJson(
      `Here is my verdict:\n{"verdict": "one", "rationale": "ok"}\nThanks!`
    );
    expect(v).toEqual({ kind: "one", rationale: "ok" });
  });

  it("drops sub-issues with empty title or summary, then re-checks the >=2 floor", () => {
    const v = parseMultifurcationJson(
      JSON.stringify({
        verdict: "many",
        rationale: "x",
        sub_issues: [
          { title: "a", summary: "first" },
          { title: "", summary: "no title" },
          { title: "b", summary: "" },
        ],
      })
    );
    // Only 1 valid sub-issue → falls back to ONE
    expect(v.kind).toBe("one");
  });
});

describe("multifurcationCommentBody", () => {
  const proposal = {
    rationale: "Two apps + a data layer = many tracks.",
    sub_issues: [
      {
        title: "Patient login shows real backend errors",
        summary: "Patients see auth failures from the real auth service.",
      },
      {
        title: "Therapist appointment list shows real bookings",
        summary: "Therapists see today's actual appointments.",
        depends_on: ["Patient login shows real backend errors"],
      },
    ],
  };

  it("includes the slowcook:multifurcation sentinel comment", () => {
    const body = multifurcationCommentBody(proposal, { issueTitle: "Everything per mock" });
    expect(body).toContain("<!-- slowcook:multifurcation -->");
  });

  it("lists each sub-issue with title + summary + depends_on", () => {
    const body = multifurcationCommentBody(proposal, { issueTitle: "x" });
    expect(body).toContain("**1. Patient login shows real backend errors**");
    expect(body).toContain("Patients see auth failures from the real auth service.");
    expect(body).toContain("**2. Therapist appointment list shows real bookings**");
    expect(body).toContain('_Depends on: "Patient login shows real backend errors"_');
  });

  it("folds rationale into a <details> block (not the lead)", () => {
    const body = multifurcationCommentBody(proposal, { issueTitle: "x" });
    const detailsIdx = body.indexOf("<details>");
    const firstSubIdx = body.indexOf("**1.");
    expect(firstSubIdx).toBeGreaterThan(-1);
    expect(detailsIdx).toBeGreaterThan(firstSubIdx);
    expect(body).toContain("Two apps + a data layer = many tracks.");
  });

  it("escapes HTML-y characters in title + summary", () => {
    const body = multifurcationCommentBody(
      {
        rationale: "x",
        sub_issues: [
          { title: "Patient <admin> page", summary: "with <em>emphasis</em>" },
          { title: "Therapist page", summary: "fine" },
        ],
      },
      { issueTitle: "Issue with <html>" }
    );
    expect(body).toContain("Patient &lt;admin&gt; page");
    expect(body).toContain("with &lt;em&gt;emphasis&lt;/em&gt;");
    expect(body).toContain("Issue with &lt;html&gt;");
    expect(body).not.toContain("Patient <admin> page");
  });
});

describe("hasExistingMultifurcationComment", () => {
  it("returns true when the sentinel is present in any comment body", () => {
    expect(
      hasExistingMultifurcationComment([
        { body: "looks great" },
        { body: "<!-- slowcook:multifurcation -->\n### slowcook" },
      ])
    ).toBe(true);
  });

  it("returns false when no comment carries the sentinel", () => {
    expect(
      hasExistingMultifurcationComment([
        { body: "looks great" },
        { body: "did we split this?" },
      ])
    ).toBe(false);
  });

  it("returns false on empty comment list", () => {
    expect(hasExistingMultifurcationComment([])).toBe(false);
  });
});
