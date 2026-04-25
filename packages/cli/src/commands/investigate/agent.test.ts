import { describe, it, expect } from "vitest";
import {
  parseSimpleYaml,
  parseBugProfileBlock,
  type InvestigateContext,
} from "./agent.js";

const ctx: InvestigateContext = {
  repoRoot: "/tmp/fake",
  anthropicApiKey: "sk-fake",
  model: "claude-opus-4-7",
  bugId: "B-99",
  cliVersion: "0.13.0-alpha.2b",
  issue: {
    number: 135,
    title: "/feed reactor names not hyperlinked",
    body: "(body)",
    priorComments: [],
  },
  now: () => new Date("2026-04-25T22:00:00.000Z"),
};

describe("parseSimpleYaml", () => {
  it("parses scalar key/value pairs", () => {
    const out = parseSimpleYaml(`
schema_version: 1
status: investigated
title: "Bug X"
`);
    expect(out["schema_version"]).toBe(1);
    expect(out["status"]).toBe("investigated");
    expect(out["title"]).toBe("Bug X");
  });

  it("parses string-list children", () => {
    const out = parseSimpleYaml(`
symptom:
  - "first symptom"
  - "second symptom"
`);
    expect(out["symptom"]).toEqual(["first symptom", "second symptom"]);
  });

  it("parses nested object children (failure_locus shape)", () => {
    const out = parseSimpleYaml(`
failure_locus:
  file: "src/foo.ts"
  line: 42
  diagnosis: "X"
`);
    expect(out["failure_locus"]).toEqual({
      file: "src/foo.ts",
      line: 42,
      diagnosis: "X",
    });
  });

  it("parses block scalars (| literal style)", () => {
    const out = parseSimpleYaml(`
failure_locus:
  file: "src/foo.ts"
  diagnosis: |
    Line 1.
    Line 2.
    Line 3.
`);
    const fl = out["failure_locus"] as { diagnosis: string };
    expect(fl.diagnosis).toBe("Line 1.\nLine 2.\nLine 3.");
  });

  it("parses lists of objects (related_specs shape)", () => {
    const out = parseSimpleYaml(`
related_specs:
  - id: "story-007"
    relationship: touches
    note: "shared file"
  - id: "story-009"
    relationship: related
`);
    expect(out["related_specs"]).toEqual([
      { id: "story-007", relationship: "touches", note: "shared file" },
      { id: "story-009", relationship: "related" },
    ]);
  });

  it("ignores blank lines and comments", () => {
    const out = parseSimpleYaml(`
# top comment
schema_version: 1

# blank above
status: investigated
`);
    expect(out["schema_version"]).toBe(1);
    expect(out["status"]).toBe("investigated");
  });
});

describe("parseBugProfileBlock", () => {
  it("extracts a valid <bug_profile> block and overrides server-side fields", () => {
    const finalText = `
Some preamble from the agent.

<bug_profile>
schema_version: 1
bug_id: B-1
title: "/feed reactor names not hyperlinked"
source_issue: "#135"
status: investigated
investigated_by: "stale-value-the-server-overrides"
created_at: "1999-01-01T00:00:00.000Z"

symptom:
  - "Names render as plain text on /feed despite story-013 brew."

expected:
  - "Each name should be a Link to /u/<handle>."

reproduction:
  - "Load /feed as authenticated user."

failure_locus:
  file: "src/app/api/feed/connections/route.ts"
  line: 38
  function: "GET"
  diagnosis: "Selects (id, display_name) from profiles but FeedPage reads member.handle."

regression_assertion:
  - "Given a connection-reaction row, when /feed renders, then the reactor name links to /u/<handle>."

fix_scope:
  - "src/app/api/feed/connections/route.ts"
</bug_profile>

trailing text
`;
    const profile = parseBugProfileBlock(finalText, ctx);
    expect(profile.bug_id).toBe("B-99"); // overridden
    expect(profile.investigated_by).toBe("slowcook-investigate@0.13.0-alpha.2b"); // overridden
    expect(profile.created_at).toBe("2026-04-25T22:00:00.000Z"); // overridden
    expect(profile.title).toBe("/feed reactor names not hyperlinked");
    expect(profile.source_issue).toBe("#135");
    expect(profile.failure_locus.file).toBe("src/app/api/feed/connections/route.ts");
    expect(profile.failure_locus.line).toBe(38);
    expect(profile.symptom).toHaveLength(1);
  });

  it("throws when no <bug_profile> block is present", () => {
    expect(() => parseBugProfileBlock("just chatter", ctx)).toThrow(
      /did not emit a <bug_profile>/
    );
  });

  it("throws when the inner YAML fails schema validation", () => {
    const bad = `
<bug_profile>
schema_version: 99
bug_id: not-bug-id
title: "x"
source_issue: "#1"
status: investigated
investigated_by: "x"
created_at: "x"
symptom:
  - "x"
expected:
  - "x"
reproduction:
  - "x"
failure_locus:
  file: "x"
  diagnosis: "x"
regression_assertion:
  - "x"
fix_scope:
  - "x"
</bug_profile>
`;
    expect(() => parseBugProfileBlock(bad, ctx)).toThrow(/schema_version|invalid/);
  });
});
