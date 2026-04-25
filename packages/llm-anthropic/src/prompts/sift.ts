/**
 * Prompts for the `slowcook sift` agent.
 *
 * Sift is the bug-flow analogue of brew. Where brew is exploratory
 * and ratchets across many iterations to flip many tests green, sift
 * is **narrow**: one bug, one regression test, minimum-diff fix.
 *
 * The system prompt has a different orientation from brew's:
 *  - "the regression test is the contract" (not "the spec")
 *  - "the bug profile names the failure locus — go there first"
 *  - "touch the named file and nothing else; halt voluntarily if
 *    the fix needs more"
 *  - "this is restoration, not feature work — match existing patterns
 *    instead of inventing"
 */

export const SIFT_SYSTEM = `You are the sift agent for slowcook — a TDD-first bug-fix flow.

## Your role

You receive a bug profile (from investigate) and a regression test (from recipe --regression). The regression test is currently RED against the codebase. Your job: make a minimum-diff code change that flips it to GREEN, without disturbing anything else.

You are NOT brew. Brew implements features from a fresh spec — you implement fixes for known regressions. Different posture:

- **The regression test IS the contract.** You don't read the spec; you read the test. The test names exactly what behavior must hold; your fix makes that behavior hold.
- **The bug profile names the failure locus.** The investigate agent already did the diagnostic work — \`failure_locus.file\`, \`.line\`, \`.function\`, \`.diagnosis\`. Trust that. Open the file, find the named function, see why the test is failing.
- **Stay inside fix_scope.** The bug profile lists \`fix_scope\` paths — those are your allowed_paths. If your edit needs to touch something outside, halt voluntarily and let the operator widen scope (the locus is probably wrong).
- **Restoration, not invention.** Match the patterns already in the file. If you're tempted to introduce a new pattern, halt — that's a story-shaped change, not a bug fix.
- **Minimum diff.** Bug fixes that look like refactors are bug fixes that have lost the plot. If your diff is more than ~30 lines across more than 2 files, you've drifted. Halt.

## Tools

- **read_file(path)** — read a file in full.
- **outline_file(path)** — compact ~200-token outline (imports, exports, signatures with line numbers). Use first.
- **list_directory(path)** — see what's in a dir.
- **find_references(symbol)** — find all use sites of a symbol; useful before renaming or extending an existing function.
- **find_definition(symbol)** — find where a symbol is declared.
- **grep(pattern, glob?)** — repo-wide ripgrep.
- **write_file(path, contents)** — replace a file with new contents. Read first, then write the COMPLETE updated contents.

You do NOT have \`run_tests\` — slowcook runs the regression test between your turns and tells you the result in the next prompt. Your only output per turn is read calls + at most one write call.

## Halting voluntarily

If after one turn of investigation the fix doesn't look minimum-diff
within the bug profile's \`fix_scope\`, end your turn with:

\`\`\`
<halt>
<reason>One-line reason — e.g., "fix requires touching files outside fix_scope" or "regression test asserts behavior the named locus doesn't actually control".</reason>
</halt>
\`\`\`

The operator picks up your halt, edits the bug profile or widens the scope, and re-runs sift. **Don't guess.** A wrong fix that flips the regression test green by accident is worse than a clean halt — sift's mistake compounds into the next bug.

## Iteration limits

Default budget: 3 iterations, ~$0.50 spend cap. The harness halts you automatically beyond that. If you can't fix it in 3 turns, the bug profile is wrong or the scope is too narrow — halt voluntarily on iteration 2 with a diagnostic.
`;

/**
 * Anthropic-shape tool definitions sift presents to the LLM. Subset
 * of brew's: read tools + write_file. Excludes brew's
 * \`justify_diff_overflow\` (sift halts instead of overflowing) and
 * \`find_handler\` (sift's failure locus is already named).
 */
export const SIFT_TOOLS = [
  {
    name: "read_file",
    description:
      "Read a file's full contents. Always read before write_file on the same path.",
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
      "Compact outline (imports, top-level exports, signatures with line numbers). Use first to scope.",
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
      "All use sites of a symbol across the repo (file:line entries).",
    input_schema: {
      type: "object" as const,
      properties: {
        symbol: { type: "string" as const, description: "Identifier name." },
      },
      required: ["symbol"],
    },
  },
  {
    name: "find_definition",
    description: "Where a symbol is declared.",
    input_schema: {
      type: "object" as const,
      properties: {
        symbol: { type: "string" as const, description: "Identifier name." },
      },
      required: ["symbol"],
    },
  },
  {
    name: "grep",
    description:
      "Repo-wide ripgrep. Use when find_references is too narrow (e.g. searching column names in SQL files).",
    input_schema: {
      type: "object" as const,
      properties: {
        pattern: { type: "string" as const, description: "Pattern to search." },
        glob: {
          type: "string" as const,
          description: "Optional glob (e.g., 'supabase/migrations/*.sql').",
        },
      },
      required: ["pattern"],
    },
  },
  {
    name: "write_file",
    description:
      "Create or fully replace a file. ALWAYS read first, then write the complete updated contents. Restricted to paths inside the bug profile's fix_scope.",
    input_schema: {
      type: "object" as const,
      properties: {
        path: { type: "string" as const, description: "Repo-relative path." },
        contents: { type: "string" as const, description: "Full new file contents." },
      },
      required: ["path", "contents"],
    },
  },
];

export interface SiftTurnPromptArgs {
  iteration: number;
  maxIterations: number;
  bugProfileYaml: string;
  regressionTestPath: string;
  regressionTestSrc: string;
  /** Latest test run result. Empty on iter 1. */
  testResult?: {
    status: "red" | "green";
    /** Vitest failure message for the regression test (when red). */
    failureMessage?: string;
  };
  /** Files sift has touched in prior iters. Empty on iter 1. */
  priorEdits?: string[];
}

export function buildSiftTurnPrompt(args: SiftTurnPromptArgs): string {
  const lines: string[] = [];
  lines.push(`# Sift iteration ${args.iteration} of ${args.maxIterations}`);
  lines.push("");
  lines.push("## Bug profile");
  lines.push("```yaml");
  lines.push(args.bugProfileYaml);
  lines.push("```");
  lines.push("");
  lines.push("## Regression test (the contract)");
  lines.push(`File: \`${args.regressionTestPath}\``);
  lines.push("```ts");
  lines.push(args.regressionTestSrc);
  lines.push("```");
  lines.push("");
  if (args.testResult) {
    if (args.testResult.status === "green") {
      lines.push("## Last run: GREEN");
      lines.push("");
      lines.push(
        "The regression test now passes. You're done — emit a `<halt>` with `<reason>regression green</reason>` so the harness can wrap up."
      );
    } else {
      lines.push("## Last run: RED");
      if (args.testResult.failureMessage) {
        lines.push("```");
        lines.push(args.testResult.failureMessage.slice(0, 1500));
        lines.push("```");
      } else {
        lines.push("(no failure message captured — run the regression file by hand to see why)");
      }
    }
    lines.push("");
  }
  if (args.priorEdits && args.priorEdits.length > 0) {
    lines.push("## Prior edits this run");
    for (const e of args.priorEdits) lines.push(`- \`${e}\``);
    lines.push("");
  }
  lines.push("## Your turn");
  lines.push(
    "Read the failure_locus file, identify why the regression assertion fails, write the minimum diff that flips it. Stay inside fix_scope. Halt voluntarily if the fix needs more."
  );
  return lines.join("\n");
}
