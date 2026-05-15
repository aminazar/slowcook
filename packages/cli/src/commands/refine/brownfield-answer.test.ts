import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  hasBrownfield,
  parseAnswerJson,
  formatAnsweredDetails,
  formatUnansweredQuestions,
  composePassBComment,
} from "./brownfield-answer.js";

function makeRepo(): string {
  return mkdtempSync(join(tmpdir(), "bf-answer-test-"));
}

describe("hasBrownfield detector (sc#82 precursor)", () => {
  let repo: string;
  beforeEach(() => {
    repo = makeRepo();
  });

  it("false on empty greenfield", () => {
    expect(hasBrownfield(repo)).toBe(false);
  });

  it("true when .brewing/context.md is non-trivial", () => {
    mkdirSync(join(repo, ".brewing"), { recursive: true });
    writeFileSync(
      join(repo, ".brewing", "context.md"),
      "## Project\n\nA social link-sharing platform built on Supabase.\n",
      "utf8"
    );
    expect(hasBrownfield(repo)).toBe(true);
  });

  it("false when context.md is empty / trivially short", () => {
    mkdirSync(join(repo, ".brewing"), { recursive: true });
    writeFileSync(join(repo, ".brewing", "context.md"), "tiny\n", "utf8");
    expect(hasBrownfield(repo)).toBe(false);
  });

  it("true when entities/ has files", () => {
    mkdirSync(join(repo, "src", "lib", "entities"), { recursive: true });
    writeFileSync(
      join(repo, "src", "lib", "entities", "profiles.ts"),
      "export interface Profile { id: string; }\n",
      "utf8"
    );
    expect(hasBrownfield(repo)).toBe(true);
  });

  it("ignores entities/index.ts barrel-only case", () => {
    mkdirSync(join(repo, "src", "lib", "entities"), { recursive: true });
    writeFileSync(
      join(repo, "src", "lib", "entities", "index.ts"),
      "export {};\n",
      "utf8"
    );
    expect(hasBrownfield(repo)).toBe(false);
  });

  it("true when specs/_index.yaml has stories", () => {
    mkdirSync(join(repo, "specs"), { recursive: true });
    writeFileSync(
      join(repo, "specs", "_index.yaml"),
      "schema_version: 1\nstories:\n  '001':\n    title: First\n    status: active\n",
      "utf8"
    );
    expect(hasBrownfield(repo)).toBe(true);
  });

  it("true when brownfield diagrams exist", () => {
    mkdirSync(join(repo, ".brewing", "diagrams"), { recursive: true });
    writeFileSync(
      join(repo, ".brewing", "diagrams", "entities.md"),
      "# Entities\n\nprofiles, sessions\n",
      "utf8"
    );
    expect(hasBrownfield(repo)).toBe(true);
  });
});

describe("parseAnswerJson", () => {
  it("parses well-formed JSON", () => {
    const raw = JSON.stringify({
      answered: [{ question: "Q1?", answer: "A1", source: "S1" }],
      unanswered: [{ question: "Q2?", why_unanswered: "PM judgement" }],
    });
    const out = parseAnswerJson(raw);
    expect(out.answered).toHaveLength(1);
    expect(out.unanswered).toHaveLength(1);
    expect(out.answered[0]!.answer).toBe("A1");
  });

  it("strips ```json fences", () => {
    const raw = '```json\n{"answered": [], "unanswered": []}\n```';
    expect(parseAnswerJson(raw)).toEqual({ answered: [], unanswered: [] });
  });

  it("ignores leading prose by finding first/last brace", () => {
    const raw = 'Here is the JSON:\n{"answered": [], "unanswered": []}\nDone.';
    expect(parseAnswerJson(raw)).toEqual({ answered: [], unanswered: [] });
  });

  it("filters out malformed entries (missing fields)", () => {
    const raw = JSON.stringify({
      answered: [
        { question: "Q1?", answer: "A", source: "S" },
        { question: "Q2?" }, // missing answer + source
        "not even an object",
      ],
      unanswered: [
        { question: "Q3?", why_unanswered: "PM" },
        { question: "no reason" }, // missing why_unanswered
      ],
    });
    const out = parseAnswerJson(raw);
    expect(out.answered).toHaveLength(1);
    expect(out.unanswered).toHaveLength(1);
  });

  it("empty arrays when missing keys", () => {
    expect(parseAnswerJson("{}")).toEqual({ answered: [], unanswered: [] });
  });

  it("throws on truly malformed JSON", () => {
    expect(() => parseAnswerJson("not json at all here")).toThrow();
  });
});

describe("formatAnsweredDetails", () => {
  it("empty string when nothing answered", () => {
    expect(formatAnsweredDetails([])).toBe("");
  });

  it("renders one-question details block", () => {
    const md = formatAnsweredDetails([
      { question: "Patient and therapist separated?", answer: "Yes, role split via profiles.role check", source: "entities-digest: profiles.role" },
    ]);
    expect(md).toContain("<details>");
    expect(md).toContain("</details>");
    expect(md).toContain("1 question answered");
    expect(md).toContain("Patient and therapist separated?");
    expect(md).toContain("entities-digest: profiles.role");
  });

  it("pluralizes correctly with >1", () => {
    const md = formatAnsweredDetails([
      { question: "Q1?", answer: "A", source: "S" },
      { question: "Q2?", answer: "A", source: "S" },
    ]);
    expect(md).toContain("2 questions answered");
  });
});

describe("formatUnansweredQuestions", () => {
  it("empty string when none", () => {
    expect(formatUnansweredQuestions([])).toBe("");
  });

  it("preserves verbatim question text including options", () => {
    const md = formatUnansweredQuestions([
      {
        question: "How should the validation error appear?\n   (a) Inline below field\n   (b) Toast",
        why_unanswered: "ambiguous",
      },
      { question: "Time-to-confirm SLA?", why_unanswered: "PM judgement" },
    ]);
    expect(md).toContain("**1.**");
    expect(md).toContain("(a) Inline below field");
    expect(md).toContain("**2.**");
    expect(md).toContain("Time-to-confirm SLA?");
  });
});

describe("composePassBComment", () => {
  it("falls back to original markdown when Pass B produced zero questions", () => {
    const fallback = "**Q1.** Original Pass A question?";
    const out = composePassBComment(
      { answered: [], unanswered: [], costUsd: 0.1, usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreateTokens: 0 } },
      fallback
    );
    expect(out).toBe(fallback);
  });

  it("shows intro note + filtered list + details when some answered", () => {
    const out = composePassBComment(
      {
        answered: [{ question: "Q-known?", answer: "A", source: "S" }],
        unanswered: [{ question: "Q-needed?", why_unanswered: "PM" }],
        costUsd: 0.2,
        usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreateTokens: 0 },
      },
      "(fallback shouldn't be used)"
    );
    expect(out).toContain("Checked brownfield first");
    expect(out).toContain("**1 of 2**");
    expect(out).toContain("Q-needed?");
    expect(out).not.toContain("Q-known?\n\nAnswer"); // Q-known shows in details, not main body
    expect(out).toContain("<details>");
  });

  it("emits a 'proceed to spec' note when all questions answered", () => {
    const out = composePassBComment(
      {
        answered: [
          { question: "Q1?", answer: "A", source: "S" },
          { question: "Q2?", answer: "A", source: "S" },
        ],
        unanswered: [],
        costUsd: 0.2,
        usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreateTokens: 0 },
      },
      "(fallback)"
    );
    expect(out).toContain("All 2 draft questions were answered");
    expect(out).toContain("needs-refinement");
    expect(out).toContain("<details>");
  });

  it("no intro note when nothing answered (just falls through to questions)", () => {
    const out = composePassBComment(
      {
        answered: [],
        unanswered: [
          { question: "Q1?", why_unanswered: "missing" },
          { question: "Q2?", why_unanswered: "PM" },
        ],
        costUsd: 0.2,
        usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreateTokens: 0 },
      },
      "(fallback)"
    );
    expect(out).not.toContain("Checked brownfield first");
    expect(out).toContain("**1.** Q1?");
    expect(out).toContain("**2.** Q2?");
    expect(out).not.toContain("<details>");
  });
});
