import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseRenameChain,
  parseLogIntoCommits,
  computeCoChanges,
  parseGhPRList,
  indexPRsByFile,
  tokeniseForCorpus,
  buildPRSpecCorpus,
  computeGitAttention,
  type PRRecord,
} from "./git-attention.js";

describe("parseRenameChain", () => {
  it("extracts old paths from R-status lines in name-status output", () => {
    const stdout = [
      "",
      "R094\tsrc/components/ReactionsPage.tsx\tsrc/components/MemberReactionsPage.tsx",
      "",
      "M\tsrc/components/MemberReactionsPage.tsx",
      "",
      "R087\tsrc/old/Reactions.tsx\tsrc/components/ReactionsPage.tsx",
      "",
      "A\tsrc/old/Reactions.tsx",
    ].join("\n");
    const chain = parseRenameChain(stdout, "src/components/MemberReactionsPage.tsx");
    expect(chain).toEqual([
      "src/components/ReactionsPage.tsx",
      "src/old/Reactions.tsx",
    ]);
  });

  it("ignores non-rename lines + drops the current file itself", () => {
    const stdout = "M\tsrc/foo.tsx\nR090\tsrc/foo.tsx\tsrc/foo.tsx\n";
    expect(parseRenameChain(stdout, "src/foo.tsx")).toEqual([]);
  });

  it("dedupes repeated rename sources", () => {
    const stdout = [
      "R094\tsrc/A.tsx\tsrc/B.tsx",
      "R092\tsrc/A.tsx\tsrc/B.tsx",
    ].join("\n");
    expect(parseRenameChain(stdout, "src/B.tsx")).toEqual(["src/A.tsx"]);
  });
});

describe("parseLogIntoCommits", () => {
  it("groups files under their COMMIT header", () => {
    const stdout = [
      "COMMIT abc",
      "src/a.ts",
      "src/b.ts",
      "",
      "COMMIT def",
      "src/c.ts",
    ].join("\n");
    expect(parseLogIntoCommits(stdout)).toEqual([
      { sha: "abc", files: ["src/a.ts", "src/b.ts"] },
      { sha: "def", files: ["src/c.ts"] },
    ]);
  });

  it("returns [] on empty stdout", () => {
    expect(parseLogIntoCommits("")).toEqual([]);
  });
});

describe("computeCoChanges", () => {
  it("ranks co-changing files by frequency + normalises strengths", () => {
    const stdout = [
      "COMMIT 1",
      "src/a.ts",
      "src/b.ts",
      "src/c.ts",
      "",
      "COMMIT 2",
      "src/a.ts",
      "src/b.ts",
      "",
      "COMMIT 3",
      "src/a.ts",
      "src/c.ts",
    ].join("\n");
    const fakeGit = () => stdout;
    const result = computeCoChanges(
      ["src/a.ts", "src/b.ts", "src/c.ts"],
      fakeGit,
      { windowMonths: 6, maxFilesPerCommit: 50, topPerFile: 5 }
    );
    // a co-occurs with b in 2 commits, with c in 2 commits; 4 total
    // co-change events → 0.5 strength each. Insertion order preserves
    // b before c (b comes first in commit 1's file list).
    expect(result["src/a.ts"]).toEqual([
      { file: "src/b.ts", strength: 0.5 },
      { file: "src/c.ts", strength: 0.5 },
    ]);
  });

  it("skips mass-refactor commits over maxFilesPerCommit", () => {
    const massFiles = Array.from({ length: 60 }, (_, i) => `src/f${i}.ts`);
    const stdout = ["COMMIT mass", ...massFiles].join("\n");
    const result = computeCoChanges(["src/f0.ts", "src/f1.ts"], () => stdout, {
      windowMonths: 6,
      maxFilesPerCommit: 50,
      topPerFile: 5,
    });
    expect(result).toEqual({});
  });

  it("ignores commits with no overlap with tracked files", () => {
    const stdout = ["COMMIT 1", "other/x.ts", "other/y.ts"].join("\n");
    const result = computeCoChanges(["src/a.ts"], () => stdout, {
      windowMonths: 6,
      maxFilesPerCommit: 50,
      topPerFile: 5,
    });
    expect(result).toEqual({});
  });
});

describe("parseGhPRList", () => {
  it("parses gh JSON into PRRecord[]", () => {
    const json = JSON.stringify([
      {
        number: 42,
        title: "feat: thing",
        body: "body text",
        mergedAt: "2026-05-01T00:00:00Z",
        files: [{ path: "src/a.ts" }, { path: "src/b.ts" }],
      },
      {
        number: 43,
        title: "open one",
        body: "",
        mergedAt: null,
        files: [{ path: "src/c.ts" }],
      },
    ]);
    const prs = parseGhPRList(json);
    expect(prs).toHaveLength(2);
    expect(prs[0]).toMatchObject({ number: 42, title: "feat: thing", merged_at: "2026-05-01T00:00:00Z" });
    expect(prs[0]!.files).toEqual(["src/a.ts", "src/b.ts"]);
    expect(prs[1]!.merged_at).toBeNull();
  });

  it("returns [] on malformed JSON", () => {
    expect(parseGhPRList("not json")).toEqual([]);
    expect(parseGhPRList("{}")).toEqual([]);
  });
});

describe("indexPRsByFile", () => {
  const prs: PRRecord[] = [
    {
      number: 1,
      title: "old merged",
      body: "",
      merged_at: "2026-04-01T00:00:00Z",
      files: ["src/a.ts"],
    },
    {
      number: 2,
      title: "new merged",
      body: "",
      merged_at: "2026-05-15T00:00:00Z",
      files: ["src/a.ts", "src/b.ts"],
    },
    {
      number: 3,
      title: "open",
      body: "",
      merged_at: null,
      files: ["src/a.ts"],
    },
    {
      number: 99,
      title: "untracked",
      body: "",
      merged_at: null,
      files: ["other/x.ts"],
    },
  ];

  it("orders open PRs before merged, then merged newest-first", () => {
    const result = indexPRsByFile(prs, ["src/a.ts", "src/b.ts"]);
    expect(result["src/a.ts"]!.map((p) => p.number)).toEqual([3, 2, 1]);
    expect(result["src/b.ts"]!.map((p) => p.number)).toEqual([2]);
  });

  it("caps each file at 5 PRs", () => {
    const many: PRRecord[] = Array.from({ length: 8 }, (_, i) => ({
      number: i + 1,
      title: `pr ${i}`,
      body: "",
      merged_at: `2026-05-0${i + 1}T00:00:00Z`,
      files: ["src/a.ts"],
    }));
    const result = indexPRsByFile(many, ["src/a.ts"]);
    expect(result["src/a.ts"]).toHaveLength(5);
  });
});

describe("tokeniseForCorpus", () => {
  it("strips stopwords + dedupes + lowercases", () => {
    const tokens = tokeniseForCorpus(
      "The Reactions Page handles the bookmark feed for member rewos."
    );
    expect(tokens).toContain("reactions");
    expect(tokens).toContain("page");
    expect(tokens).toContain("bookmark");
    expect(tokens).toContain("feed");
    expect(tokens).toContain("member");
    expect(tokens).toContain("rewos");
    expect(tokens).not.toContain("the");
    expect(tokens).not.toContain("for");
    // deduped
    expect(tokens.filter((t) => t === "the")).toHaveLength(0);
  });

  it("caps token list at 60", () => {
    const longText = Array.from({ length: 200 }, (_, i) => `word${i}`).join(" ");
    expect(tokeniseForCorpus(longText)).toHaveLength(60);
  });
});

describe("buildPRSpecCorpus", () => {
  let repo: string;

  beforeAll(() => {
    repo = mkdtempSync(join(tmpdir(), "slowcook-corpus-"));
    mkdirSync(join(repo, "specs"), { recursive: true });
    writeFileSync(
      join(repo, "specs/story-007.yaml"),
      "title: Reactions feed\nsummary: Show member reactions in a chronological feed.\n",
      "utf8"
    );
    writeFileSync(
      join(repo, "specs/story-008.yaml"),
      "title: Pin a rewo\nsummary: Allow members to pin a reaction so it surfaces in the strip.\n",
      "utf8"
    );
  });

  afterAll(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  it("combines PR + spec entries with stable ids + token lists", () => {
    const prs: PRRecord[] = [
      {
        number: 99,
        title: "feat: pin rewo",
        body: "Adds the pin strip to /member/[handle].",
        merged_at: "2026-05-01T00:00:00Z",
        files: ["src/components/PinnedStrip.tsx"],
      },
    ];
    const corpus = buildPRSpecCorpus(prs, repo);
    const ids = corpus.map((e) => e.id);
    expect(ids).toContain("pr#99");
    expect(ids).toContain("spec:story-007");
    expect(ids).toContain("spec:story-008");

    const pinSpec = corpus.find((e) => e.id === "spec:story-008")!;
    expect(pinSpec.title).toBe("Pin a rewo");
    expect(pinSpec.tokens).toContain("pin");
    expect(pinSpec.tokens).toContain("strip");

    const pr = corpus.find((e) => e.id === "pr#99")!;
    expect(pr.files_touched).toEqual(["src/components/PinnedStrip.tsx"]);
    expect(pr.tokens).toContain("pin");
    expect(pr.tokens).toContain("rewo");
  });

  it("returns just PRs when specs/ is absent", () => {
    const repo2 = mkdtempSync(join(tmpdir(), "slowcook-corpus-empty-"));
    try {
      const corpus = buildPRSpecCorpus(
        [{ number: 1, title: "x", body: "y", merged_at: null, files: [] }],
        repo2
      );
      expect(corpus).toHaveLength(1);
      expect(corpus[0]!.id).toBe("pr#1");
    } finally {
      rmSync(repo2, { recursive: true, force: true });
    }
  });
});

describe("computeGitAttention orchestrator", () => {
  it("degrades gracefully when git + gh both fail", () => {
    const repo = mkdtempSync(join(tmpdir(), "slowcook-attn-fail-"));
    try {
      const result = computeGitAttention({
        repoRoot: repo,
        trackedFiles: ["src/a.ts"],
        gitExec: () => {
          throw new Error("not a git repo");
        },
        ghExec: () => {
          throw new Error("gh: command not found");
        },
      });
      expect(result.rename_chains).toEqual({});
      expect(result.co_changes).toEqual({});
      expect(result.recent_prs_by_file).toEqual({});
      expect(result.pr_spec_corpus).toEqual([]);
      expect(result.warnings.length).toBeGreaterThanOrEqual(2);
      expect(result.warnings.join(" ")).toMatch(/git/i);
      expect(result.warnings.join(" ")).toMatch(/gh/i);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("wires all four signals when git + gh both work", () => {
    const repo = mkdtempSync(join(tmpdir(), "slowcook-attn-ok-"));
    try {
      mkdirSync(join(repo, "specs"), { recursive: true });
      writeFileSync(
        join(repo, "specs/story-001.yaml"),
        "title: Bookmarks\nsummary: members bookmark rewos.\n",
        "utf8"
      );

      const fakeGit = (cmd: string): string => {
        if (cmd.startsWith("rev-parse")) return ".git\n";
        if (cmd.includes("--follow")) {
          // rename history for src/components/Reactions.tsx
          return "R094\tsrc/old/Old.tsx\tsrc/components/Reactions.tsx\n";
        }
        // co-change log
        return [
          "COMMIT 1",
          "src/components/Reactions.tsx",
          "src/components/PinnedStrip.tsx",
          "",
          "COMMIT 2",
          "src/components/Reactions.tsx",
          "src/components/PinnedStrip.tsx",
        ].join("\n");
      };

      const fakeGh = (_cmd: string): string =>
        JSON.stringify([
          {
            number: 154,
            title: "feat: pin rewos",
            body: "Pinned strip on /member/[handle].",
            mergedAt: "2026-05-04T00:00:00Z",
            files: [{ path: "src/components/Reactions.tsx" }],
          },
        ]);

      const result = computeGitAttention({
        repoRoot: repo,
        trackedFiles: [
          "src/components/Reactions.tsx",
          "src/components/PinnedStrip.tsx",
        ],
        gitExec: fakeGit,
        ghExec: fakeGh,
      });

      expect(result.warnings).toEqual([]);
      expect(result.rename_chains["src/components/Reactions.tsx"]).toEqual([
        "src/old/Old.tsx",
      ]);
      expect(result.co_changes["src/components/Reactions.tsx"]).toEqual([
        { file: "src/components/PinnedStrip.tsx", strength: 1 },
      ]);
      expect(result.recent_prs_by_file["src/components/Reactions.tsx"]).toHaveLength(1);
      expect(result.pr_spec_corpus.map((e) => e.id).sort()).toEqual([
        "pr#154",
        "spec:story-001",
      ]);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});
