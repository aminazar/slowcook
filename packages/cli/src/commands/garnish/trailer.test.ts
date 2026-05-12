import { describe, it, expect } from "vitest";
import {
  formatTrailer,
  parseTrailerLine,
  parseTrailers,
  agentFromAuthor,
  composeCommitMessage,
  type UpstreamRef,
} from "./trailer.js";

describe("formatTrailer", () => {
  it("emits one trailer line per ref", () => {
    const out = formatTrailer([
      { agent: "vibe", sha: "abc1234567890", file: "mock/src/Foo.tsx" },
      { agent: "plate", sha: "def4567890123", file: "mock/src/Bar.tsx" },
    ]);
    expect(out).toBe(
      [
        "Tweaks-output-of: agent=vibe sha=abc1234 file=mock/src/Foo.tsx",
        "Tweaks-output-of: agent=plate sha=def4567 file=mock/src/Bar.tsx",
      ].join("\n"),
    );
  });

  it("returns empty string for empty refs", () => {
    expect(formatTrailer([])).toBe("");
  });

  it("trims sha to 7 chars", () => {
    const out = formatTrailer([
      { agent: "vibe", sha: "abc1234567890abcdef", file: "mock/src/Foo.tsx" },
    ]);
    expect(out).toContain("sha=abc1234 ");
  });

  it("preserves short sha as-is", () => {
    const out = formatTrailer([
      { agent: "vibe", sha: "abc1234", file: "mock/src/Foo.tsx" },
    ]);
    expect(out).toContain("sha=abc1234 ");
  });
});

describe("parseTrailerLine", () => {
  it("parses a canonical trailer line", () => {
    const r = parseTrailerLine("Tweaks-output-of: agent=vibe sha=abc1234 file=mock/src/Foo.tsx");
    expect(r).toEqual({ agent: "vibe", sha: "abc1234", file: "mock/src/Foo.tsx" });
  });

  it("tolerates leading + trailing whitespace", () => {
    const r = parseTrailerLine("   Tweaks-output-of: agent=plate sha=def4567 file=src/X.ts   ");
    expect(r).toEqual({ agent: "plate", sha: "def4567", file: "src/X.ts" });
  });

  it("returns null for unrelated lines", () => {
    expect(parseTrailerLine("Co-Authored-By: foo")).toBeNull();
    expect(parseTrailerLine("random commit body line")).toBeNull();
    expect(parseTrailerLine("")).toBeNull();
  });

  it("returns null for malformed trailer (missing fields)", () => {
    expect(parseTrailerLine("Tweaks-output-of: agent=vibe sha=abc1234")).toBeNull();
    expect(parseTrailerLine("Tweaks-output-of: sha=abc1234 file=X.ts")).toBeNull();
  });

  it("captures file paths with spaces / special chars greedily", () => {
    const r = parseTrailerLine(
      "Tweaks-output-of: agent=vibe sha=abc1234 file=mock/src/(auth)/page.tsx",
    );
    expect(r?.file).toBe("mock/src/(auth)/page.tsx");
  });
});

describe("parseTrailers", () => {
  it("extracts all trailers from a multi-line body, preserving order", () => {
    const body = `
[garnish] mock/src/Foo.tsx + 1 more

Some prose body here.

Tweaks-output-of: agent=vibe sha=abc1234 file=mock/src/Foo.tsx
Tweaks-output-of: agent=plate sha=def4567 file=mock/src/Bar.tsx
`;
    const refs = parseTrailers(body);
    expect(refs).toEqual([
      { agent: "vibe", sha: "abc1234", file: "mock/src/Foo.tsx" },
      { agent: "plate", sha: "def4567", file: "mock/src/Bar.tsx" },
    ]);
  });

  it("returns empty array when body has no trailers", () => {
    expect(parseTrailers("plain old commit message")).toEqual([]);
  });

  it("ignores lines that aren't Tweaks-output-of trailers", () => {
    const body = `
[garnish] x

Co-Authored-By: someone <noreply@example.com>
Tweaks-output-of: agent=vibe sha=abc1234 file=mock/src/Foo.tsx
Some-Other-Trailer: bar
`;
    expect(parseTrailers(body)).toHaveLength(1);
  });
});

describe("agentFromAuthor", () => {
  it("recognises slowcook agent author conventions", () => {
    expect(agentFromAuthor("slowcook-vibe[bot]")).toBe("vibe");
    expect(agentFromAuthor("slowcook-plate[bot]")).toBe("plate");
    expect(agentFromAuthor("slowcook-brew[bot]")).toBe("brew");
    expect(agentFromAuthor("slowcook-chef[bot]")).toBe("chef");
    expect(agentFromAuthor("slowcook-refine[bot]")).toBe("refine");
    expect(agentFromAuthor("slowcook-recipe[bot]")).toBe("recipe");
    expect(agentFromAuthor("slowcook-testgen[bot]")).toBe("testgen");
  });

  it("returns null for human authors", () => {
    expect(agentFromAuthor("aminazar")).toBeNull();
    expect(agentFromAuthor("Amin Azar")).toBeNull();
    expect(agentFromAuthor("Some Human <human@example.com>")).toBeNull();
  });

  it("returns null for unrelated bots", () => {
    expect(agentFromAuthor("github-actions[bot]")).toBeNull();
    expect(agentFromAuthor("dependabot[bot]")).toBeNull();
    expect(agentFromAuthor("renovate[bot]")).toBeNull();
  });

  it("handles future agents that follow the convention", () => {
    expect(agentFromAuthor("slowcook-navigator[bot]")).toBe("navigator");
    expect(agentFromAuthor("slowcook-sift[bot]")).toBe("sift");
  });
});

describe("composeCommitMessage", () => {
  const refs: UpstreamRef[] = [
    { agent: "vibe", sha: "abc1234", file: "mock/src/Foo.tsx" },
  ];

  it("emits subject + blank line + trailer for single file", () => {
    const msg = composeCommitMessage({
      touchedFiles: ["mock/src/Foo.tsx"],
      upstreamRefs: refs,
    });
    expect(msg).toBe(
      [
        "[garnish] mock/src/Foo.tsx",
        "",
        "Tweaks-output-of: agent=vibe sha=abc1234 file=mock/src/Foo.tsx",
      ].join("\n"),
    );
  });

  it("summarises multi-file subjects (\"+ N more\")", () => {
    const msg = composeCommitMessage({
      touchedFiles: ["a.ts", "b.ts", "c.ts"],
      upstreamRefs: refs,
    });
    expect(msg.split("\n")[0]).toBe("[garnish] a.ts + 2 more");
  });

  it("uses '+' separator for exactly two files", () => {
    const msg = composeCommitMessage({
      touchedFiles: ["a.ts", "b.ts"],
      upstreamRefs: refs,
    });
    expect(msg.split("\n")[0]).toBe("[garnish] a.ts + b.ts");
  });

  it("includes user-provided body between subject and trailers", () => {
    const msg = composeCommitMessage({
      touchedFiles: ["mock/src/Foo.tsx"],
      upstreamRefs: refs,
      userMessage: "Tightened the spacing on the Pin button.",
    });
    expect(msg).toContain("Tightened the spacing on the Pin button.");
    // user body appears before the trailer
    const userBodyIdx = msg.indexOf("Tightened");
    const trailerIdx = msg.indexOf("Tweaks-output-of");
    expect(userBodyIdx).toBeLessThan(trailerIdx);
  });

  it("omits trailer block when upstream refs is empty", () => {
    const msg = composeCommitMessage({
      touchedFiles: ["mock/src/Foo.tsx"],
      upstreamRefs: [],
    });
    expect(msg).not.toContain("Tweaks-output-of:");
  });

  it("handles empty touchedFiles gracefully", () => {
    const msg = composeCommitMessage({
      touchedFiles: [],
      upstreamRefs: [],
    });
    expect(msg.split("\n")[0]).toBe("[garnish] (no files)");
  });
});
