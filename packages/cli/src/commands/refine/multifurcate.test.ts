import { describe, it, expect } from "vitest";
import type { Spec } from "@slowcook-ai/core";
import {
  parseMultifurcationJson,
  multifurcationCommentBody,
  hasExistingMultifurcationComment,
  buildMultifurcationUserMessage,
  digestActiveSpecs,
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

describe("parseMultifurcationJson — overlap annotation (α.45)", () => {
  it("captures existing_spec_id when the model sets it", () => {
    const v = parseMultifurcationJson(
      JSON.stringify({
        verdict: "many",
        rationale: "split + one overlap",
        sub_issues: [
          { title: "fresh", summary: "a new slice" },
          {
            title: "patient login wired",
            summary: "covered already",
            existing_spec_id: "002",
          },
        ],
      })
    );
    expect(v.kind).toBe("many");
    if (v.kind === "many") {
      expect(v.sub_issues[0]!.existing_spec_id).toBeUndefined();
      expect(v.sub_issues[1]!.existing_spec_id).toBe("002");
    }
  });

  it("normalises 'story-002' prefix variants the model might emit", () => {
    const v = parseMultifurcationJson(
      JSON.stringify({
        verdict: "many",
        rationale: "x",
        sub_issues: [
          { title: "a", summary: "x", existing_spec_id: "story-007" },
          { title: "b", summary: "y", covered_by_story: "Story-013" },
        ],
      })
    );
    expect(v.kind).toBe("many");
    if (v.kind === "many") {
      expect(v.sub_issues[0]!.existing_spec_id).toBe("007");
      expect(v.sub_issues[1]!.existing_spec_id).toBe("013");
    }
  });

  it("leaves existing_spec_id undefined when the model omits it", () => {
    const v = parseMultifurcationJson(
      JSON.stringify({
        verdict: "many",
        rationale: "x",
        sub_issues: [
          { title: "a", summary: "x" },
          { title: "b", summary: "y" },
        ],
      })
    );
    expect(v.kind).toBe("many");
    if (v.kind === "many") {
      expect(v.sub_issues.every((s) => s.existing_spec_id === undefined)).toBe(true);
    }
  });
});

describe("multifurcationCommentBody — overlap badge (α.45)", () => {
  it("renders 'already covered by story-NNN' next to overlapping sub-issues", () => {
    const body = multifurcationCommentBody(
      {
        rationale: "two slices, one overlap",
        sub_issues: [
          { title: "Patient login uses real auth", summary: "s1", existing_spec_id: "002" },
          { title: "Patient appointment list", summary: "s2" },
        ],
      },
      { issueTitle: "x" }
    );
    expect(body).toContain("already covered by story-002");
    // Sub-issue 1's title line carries the badge; sub-issue 2's does not.
    const subATitleLine = body
      .split("\n")
      .find((l) => l.startsWith("**1.")) ?? "";
    const subBTitleLine = body
      .split("\n")
      .find((l) => l.startsWith("**2.")) ?? "";
    expect(subATitleLine).toContain("already covered by story-002");
    expect(subBTitleLine).not.toContain("already covered");
  });

  it("counts overlaps in the section header", () => {
    const body = multifurcationCommentBody(
      {
        rationale: "x",
        sub_issues: [
          { title: "a", summary: "x", existing_spec_id: "001" },
          { title: "b", summary: "y", existing_spec_id: "002" },
          { title: "c", summary: "z" },
        ],
      },
      { issueTitle: "x" }
    );
    expect(body).toContain("Proposed sub-issues (3, 2 overlap existing specs)");
  });

  it("omits the overlap counter when there are no overlaps", () => {
    const body = multifurcationCommentBody(
      {
        rationale: "x",
        sub_issues: [
          { title: "a", summary: "x" },
          { title: "b", summary: "y" },
        ],
      },
      { issueTitle: "x" }
    );
    expect(body).toContain("Proposed sub-issues (2)");
    expect(body).not.toContain("overlap existing");
  });

  it("escapes story id in the badge", () => {
    const body = multifurcationCommentBody(
      {
        rationale: "x",
        sub_issues: [
          { title: "a", summary: "x", existing_spec_id: "<bad>" },
          { title: "b", summary: "y" },
        ],
      },
      { issueTitle: "x" }
    );
    expect(body).toContain("already covered by story-&lt;bad&gt;");
  });
});

describe("buildMultifurcationUserMessage — active-specs context (α.45)", () => {
  it("omits the Active specs section entirely when none provided", () => {
    const msg = buildMultifurcationUserMessage({
      issueTitle: "x",
      issueBody: "y",
    });
    expect(msg).not.toContain("Active specs");
    expect(msg).toContain("### Title\nx");
    expect(msg).toContain("### Body\ny");
  });

  it("lists active specs + reminder to use existing_spec_id when overlap is real", () => {
    const msg = buildMultifurcationUserMessage({
      issueTitle: "everything per mock",
      issueBody: "wire mock to backend",
      activeSpecs: [
        { story_id: "002", title: "Auth + role registration", summary: "OTP login flow" },
        { story_id: "007", title: "Pinned strip", summary: "" },
      ],
    });
    expect(msg).toContain("## Active specs in this repo");
    expect(msg).toContain("**story-002** \"Auth + role registration\" — OTP login flow");
    expect(msg).toContain("**story-007** \"Pinned strip\"");
    expect(msg).toContain("existing_spec_id");
    expect(msg).toMatch(/Do NOT silently omit/);
  });

  it("falls back gracefully when summary is empty (no trailing em dash)", () => {
    const msg = buildMultifurcationUserMessage({
      issueTitle: "x",
      issueBody: "y",
      activeSpecs: [{ story_id: "001", title: "No summary", summary: "" }],
    });
    expect(msg).toContain("**story-001** \"No summary\"\n");
    expect(msg).not.toContain("No summary — ");
  });
});

describe("digestActiveSpecs", () => {
  function makeSpec(over: Partial<Spec>): Spec {
    return {
      story_id: "001",
      title: "t",
      status: "active",
      created_at: "2026-05-24T00:00:00Z",
      supersedes: [],
      superseded_by: null,
      actors: [],
      preconditions: [],
      invariants: [],
      acceptance_scenarios: [],
      non_goals: [],
      ...over,
    } as Spec;
  }

  it("uses the first acceptance scenario when present", () => {
    const out = digestActiveSpecs([
      makeSpec({
        story_id: "002",
        title: "Auth",
        acceptance_scenarios: [
          "Given a user with valid OTP, when they submit, then session created.",
          "Given an expired OTP …",
        ],
        invariants: ["one session per user"],
      }),
    ]);
    expect(out).toEqual([
      {
        story_id: "002",
        title: "Auth",
        summary: "Given a user with valid OTP, when they submit, then session created.",
      },
    ]);
  });

  it("falls back to invariants then non_goals then empty", () => {
    expect(
      digestActiveSpecs([
        makeSpec({ story_id: "003", title: "Inv", invariants: ["X must hold"] }),
      ])[0]!.summary
    ).toBe("X must hold");
    expect(
      digestActiveSpecs([
        makeSpec({ story_id: "004", title: "Ng", non_goals: ["No editing"] }),
      ])[0]!.summary
    ).toBe("No editing");
    expect(digestActiveSpecs([makeSpec({ story_id: "005", title: "Empty" })])[0]!.summary).toBe(
      ""
    );
  });

  it("collapses whitespace + truncates at 150 chars", () => {
    const longText = "a".repeat(200);
    const out = digestActiveSpecs([
      makeSpec({ acceptance_scenarios: [`Given\n${longText}\twhen`] }),
    ]);
    expect(out[0]!.summary.length).toBeLessThanOrEqual(150);
    expect(out[0]!.summary).not.toMatch(/\n|\t/);
  });
});

// --- G6: approve-by-reaction split execution (rewo run, ledger G6) ---

import {
  parseMultifurcationSubIssues,
  decideMultifurcation,
  findMultifurcationComment,
  multifurcationCommentBody as bodyForRoundtrip,
} from "./multifurcate.js";

describe("parseMultifurcationSubIssues", () => {
  it("round-trips through the data marker", () => {
    const subs = [
      { title: "A <thing>", summary: "Does a.", depends_on: ["B"] },
      { title: "B", summary: "Does b.", existing_spec_id: "007" },
    ];
    const body = bodyForRoundtrip({ rationale: "why", sub_issues: subs }, { issueTitle: "Parent" });
    expect(parseMultifurcationSubIssues(body)).toEqual(subs);
  });

  it("falls back to markdown for pre-marker proposals (the #34 shape)", () => {
    const body = [
      "<!-- slowcook:multifurcation -->",
      "### slowcook · refinement agent 🍲",
      "",
      "This issue looks like **more than one story** to me.",
      "",
      "#### Proposed sub-issues (2)",
      "",
      "**1. Crawler collapses duplicate links to one content signature**",
      "",
      "When members share the same underlying content through different URLs, merge it.",
      "",
      "**2. Crawler assigns content a taxonomy category**",
      "",
      "Every crawled piece of content should be categorized.",
      "",
      "_Depends on: \"Crawler collapses duplicate links to one content signature\"_",
      "",
      "<details><summary>Why I think this should split</summary>",
      "prose that must not leak",
      "</details>",
    ].join("\n");
    const subs = parseMultifurcationSubIssues(body);
    expect(subs).toHaveLength(2);
    expect(subs![0]!.title).toBe("Crawler collapses duplicate links to one content signature");
    expect(subs![0]!.summary).toContain("merge it");
    expect(subs![1]!.depends_on).toEqual([
      "Crawler collapses duplicate links to one content signature",
    ]);
    expect(subs![1]!.summary).not.toContain("Depends on");
  });

  it("returns null when nothing is recoverable", () => {
    expect(parseMultifurcationSubIssues("no proposal here")).toBeNull();
  });
});

describe("decideMultifurcation", () => {
  it("a 👍 approves", () => {
    expect(decideMultifurcation([{ user: "pm", content: "+1" }], [])).toBe("approve");
  });
  it("a 👎 rejects, and wins over a stray 👍", () => {
    expect(
      decideMultifurcation(
        [{ user: "a", content: "+1" }, { user: "b", content: "-1" }],
        []
      )
    ).toBe("reject");
  });
  it("a human 'keep as one' reply rejects", () => {
    expect(
      decideMultifurcation([], [{ body: "Keep as one please", is_bot: false }])
    ).toBe("reject");
  });
  it("a bot echoing 'keep as one' does not reject", () => {
    expect(
      decideMultifurcation([], [{ body: "reply keep as one to...", is_bot: true }])
    ).toBe("pending");
  });
  it("nothing yet is pending (hearts and rockets don't decide)", () => {
    expect(decideMultifurcation([{ user: "pm", content: "heart" }], [])).toBe("pending");
  });
});

describe("findMultifurcationComment", () => {
  it("returns the most recent proposal", () => {
    const c = findMultifurcationComment([
      { body: "<!-- slowcook:multifurcation --> old" },
      { body: "unrelated" },
      { body: "<!-- slowcook:multifurcation --> new" },
    ]);
    expect(c!.body).toContain("new");
  });
});
