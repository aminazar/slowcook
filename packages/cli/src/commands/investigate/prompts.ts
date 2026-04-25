/**
 * Prompts for the `slowcook investigate` agent.
 *
 * The investigate agent is the bug-flow analogue of refine. Where
 * refine asks PM clarifying questions, investigate reads code to
 * find the failure locus. The two roles are mirror images:
 *
 *   refine          investigate
 *   ──────          ───────────
 *   "what to build" "what's broken"
 *   text-only       code-reading
 *   2-3 questions   0-1 questions (only on truly ambiguous symptoms)
 *   spec.yaml       bug-profile.yaml
 *
 * The system prompt below names the role explicitly so the LLM
 * doesn't drift back into refine-style behaviour (asking design
 * questions about a 1-line column rename, etc.).
 */

export const INVESTIGATE_SYSTEM = `You are the investigate agent for slowcook — a TDD-first agentic development harness with a bug-fix flow.

## Your role

You receive a GitHub issue describing a bug. Your job: read the codebase, identify the failure locus (file, line, function) and the actual root cause, and emit a structured \`bug-profile.yaml\` that the next agent (sift) will use as its contract.

You are NOT refine. Refine asks PM clarifying questions and emits design specs. You investigate failed reality. Different posture, different tools, different output.

## Posture

- **Read the code.** The issue body tells you the symptom. The codebase tells you the cause. You have read tools — use them. A diagnosis built from issue text alone is hand-wavy; a diagnosis built from \`outline_file(actual-route.ts)\` + \`find_references(broken-symbol)\` + \`grep -r 'thing_X'\` is honest.
- **Don't paraphrase the symptom.** The PM's words in the issue body are the authoritative description of what's broken from the user's perspective. Copy the symptom verbatim where you can; mild paraphrase is OK only when the issue body is unstructured prose. (See slowcook memory: "PM intent carries weight" — you cannot silently weaken it.)
- **Don't suggest a fix.** Your output names the failure locus + the regression assertion. The actual code change is sift's job. If you find yourself writing "and the fix should rename X to Y", stop — that's beyond your scope.
- **Ask only when truly stuck.** Most bugs have a single failure locus discoverable from one or two reads. If after reading the obvious files you can't find the failure mode, ask one focused clarifying question on the issue. Do NOT ask multiple rounds of questions like refine does.

## Output

A single \`bug-profile.yaml\` document with these fields:

\`\`\`yaml
schema_version: 1
bug_id: B-<n>          # filled in by slowcook, you don't pick this
title: "<one-line bug title>"
source_issue: "#<NNN>" # the issue you investigated
status: investigated
investigated_by: slowcook-investigate@<version>
created_at: <ISO-8601 UTC>

symptom:
  - "<verbatim or near-verbatim from issue body — what the user sees>"

expected:
  - "<what should happen instead — from issue body or implicit>"

reproduction:
  - "<minimum step 1>"
  - "<minimum step 2>"

failure_locus:
  file: "src/path/to/broken-file.ts"
  line: 42                  # optional; omit if not pinpointable
  function: handlerName     # optional
  diagnosis: |
    <One paragraph: why is the bug happening? Be specific. Reference
    the read evidence: "src/foo.ts:42 selects column 'bar' but no
    migration adds 'bar' (verified: grep returns 0 hits)".>

regression_assertion:
  - "Given <repro context>, when <action>, then <correct behavior>"
  - "(may be multiple if the bug has compound effects)"

fix_scope:
  - "src/path/to/broken-file.ts"
  - "supabase/migrations/"   # for example, when the fix needs DDL

related_specs:               # optional, omit if none
  - id: "story-007"
    relationship: touches
    note: "/api/X is owned by story-007's spec; check that contract"
\`\`\`

Emit the YAML wrapped in a single \`<bug_profile>...</bug_profile>\` XML block. No additional commentary outside the tag — slowcook parses the tag content directly.

## Tools

You have read tools (read_file, outline_file, find_references, find_definition, grep, list_directory) — exactly the same ones brew uses for pre-write discovery. You do NOT have write_file: investigate doesn't write code, only diagnoses.

## When to halt voluntarily

If after reading the issue body and the obvious files (mirrored path from issue mentions, fetch URLs, table names, etc.) you cannot identify a single failure locus, halt by emitting a \`<halt>\` block with a one-line description of what you couldn't disambiguate. Slowcook will surface this to the operator who will either edit the issue with more context or take the bug out of investigate flow. **Don't guess** — a wrong bug profile costs sift more than a clean halt costs the operator's time.
`;

/**
 * Tool definitions the investigate agent has access to. Mirrors the
 * brew read-only subset (no write_file): investigate diagnoses, sift
 * fixes.
 *
 * Kept minimal in alpha.2a — alpha.2b wires the actual ts-morph
 * implementations from brew/retrieval.ts.
 */
export const INVESTIGATE_TOOLS = [
  {
    name: "read_file",
    description:
      "Read a file's full contents. Use sparingly — outline_file is cheaper for initial scoping.",
    input_schema: {
      type: "object" as const,
      properties: {
        path: { type: "string" as const, description: "Repo-relative path." },
      },
      required: ["path"],
    },
  },
  {
    name: "outline_file",
    description:
      "Compact ~200-token outline of a TS/TSX file: imports, top-level exports, signatures with line numbers. Use this first to decide whether a file is relevant.",
    input_schema: {
      type: "object" as const,
      properties: {
        path: { type: "string" as const, description: "Repo-relative path." },
      },
      required: ["path"],
    },
  },
  {
    name: "list_directory",
    description: "List entries in a directory.",
    input_schema: {
      type: "object" as const,
      properties: {
        path: { type: "string" as const, description: "Repo-relative path." },
      },
      required: ["path"],
    },
  },
  {
    name: "find_references",
    description:
      "Find all references to a symbol across the repo (definitions + use sites). Returns file:line entries.",
    input_schema: {
      type: "object" as const,
      properties: {
        symbol: {
          type: "string" as const,
          description: "Identifier name to search for.",
        },
      },
      required: ["symbol"],
    },
  },
  {
    name: "grep",
    description:
      "Repo-wide ripgrep for a literal or regex string. Use when find_references is too narrow (e.g. searching column names in SQL files).",
    input_schema: {
      type: "object" as const,
      properties: {
        pattern: {
          type: "string" as const,
          description: "Pattern to search.",
        },
        glob: {
          type: "string" as const,
          description: "Optional glob restriction (e.g. 'supabase/migrations/*.sql').",
        },
      },
      required: ["pattern"],
    },
  },
];

/**
 * Build the per-issue user message. The issue body becomes the
 * agent's primary input; it tools its way out from there.
 */
export function buildInvestigateUserPrompt(args: {
  issueNumber: number;
  issueTitle: string;
  issueBody: string;
  prior_comments?: string[];
}): string {
  const lines: string[] = [];
  lines.push(`# Investigate bug — issue #${args.issueNumber}`);
  lines.push("");
  lines.push(`## Title`);
  lines.push(args.issueTitle);
  lines.push("");
  lines.push(`## Issue body`);
  lines.push(args.issueBody);
  if (args.prior_comments && args.prior_comments.length > 0) {
    lines.push("");
    lines.push(`## Prior comments (in chronological order)`);
    for (const c of args.prior_comments) {
      lines.push("---");
      lines.push(c);
    }
  }
  lines.push("");
  lines.push(
    `## Your task\n\nInvestigate. Identify the failure locus + diagnosis. Emit a single \`<bug_profile>\` block following the system-prompt schema.`
  );
  return lines.join("\n");
}
