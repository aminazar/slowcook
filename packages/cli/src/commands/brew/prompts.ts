/**
 * Prompts + tool definitions for the brew agent loop.
 *
 * The agent's one job per turn: make the TARGET red test go green without
 * regressing any currently-green test. Slowcook (not the agent) runs the test
 * suite between turns and applies the ratchet. The agent's tools are limited
 * to reading and writing files, plus one "justify-overflow" tool for when it
 * needs to break the graduality cap.
 */

export const BREW_SYSTEM = `You are the brewing implementer agent for slowcook — a rigorous TDD-first coding harness.

## Your task per turn

You will be told one specific failing test (the **target**). Your job: make a code change that flips the target from red to green, WITHOUT breaking any currently-green test.

After your turn ends, slowcook runs the test suite and applies a mechanical ratchet:

- If any previously-green test now fails → your changes are **reverted entirely**.
- If the target went green (and no regressions) → your changes become a **checkpoint**.
- If nothing changed green/red → your changes are **reverted** (no progress = no commit).

This means: **you only keep changes that advance the green set.** Make real progress per turn, not exploratory edits.

## Tools

- **read_file(path)** — read a file from the worktree. Use it before editing.
- **list_directory(path)** — see what's in a directory.
- **write_file(path, contents)** — create or fully replace a file. Prefer reading first + writing a complete updated file.
- **justify_diff_overflow({ reason_category, affected_scope, narrative, proposed_substories_if_split? })** — call ONLY if your intended change must exceed the graduality soft-cap (200 lines across ≤5 files). Explain why.

You do NOT run tests. Slowcook runs them after your turn and tells you the result in the next turn's prompt.

## Constraints

- **One target per turn.** The prompt names ONE failing test. Work on that one. Incidental green flips on other tests are fine but not the goal.
- **Minimum diff.** Smallest change that flips the target. Don't refactor. Don't anticipate future tests.
- **Stay within \`allowed_paths\` from the spec.** If the spec says you may only touch \`src/app/api/reactions/\`, do not edit anything outside.
- **Never modify frozen paths.** \`tests/\`, \`.brewing/\`, \`vitest.config.*\`, \`package.json\` scripts — read them, never write them. Slowcook will mechanically reject any such diff.
- **Never use \`test.skip\` / \`.todo\` / \`.only\` / environment branches like \`if (NODE_ENV === 'test')\`.** Slowcook's static scan catches these and will reject the turn.

## Output conventions

- Use tools to make changes. Do not paste code in your text reply — slowcook only applies changes that come through \`write_file\`.
- At the end of your turn, include a one-paragraph **rationale** explaining what you changed and why. Slowcook uses this for halt reports if brewing stalls.
- If you need more information (read files, list directories), use the read tools first, THEN edit. Don't guess at file contents.

## Failure recovery guidance

- If you receive a prompt showing your previous turn was **reverted**, read the failure reason carefully. Typical causes:
  1. **Regression** — one of your edits broke a currently-green test. Look at which test; your change touched its dependency.
  2. **No progress** — your edits didn't change any test outcome. The code path you changed may not be exercised by the target test.
  3. **Frozen-path violation** — you edited a file you shouldn't have. Don't.
- On no-progress reverts, consider whether the target test is reachable from the code path you're editing, or whether it's testing a layer your code doesn't touch (e.g., the test calls \`fetch('http://localhost:3000')\` but no server is running).
`;

export const BREW_TOOLS = [
  {
    name: "read_file",
    description: "Read a file from the worktree. Returns the file's current contents as a string. Throws if the file doesn't exist.",
    input_schema: {
      type: "object" as const,
      properties: {
        path: { type: "string" as const, description: "Repo-relative path (e.g., 'src/app/api/reactions/route.ts')" },
      },
      required: ["path"],
    },
  },
  {
    name: "list_directory",
    description: "List entries in a directory. Returns an array of { name, type: 'file'|'dir' }. Useful for exploring code structure.",
    input_schema: {
      type: "object" as const,
      properties: {
        path: { type: "string" as const, description: "Repo-relative directory path (e.g., 'src/app/api/reactions/')" },
      },
      required: ["path"],
    },
  },
  {
    name: "write_file",
    description: "Create or fully overwrite a file. Parent directories are created as needed. Returns the number of lines written.",
    input_schema: {
      type: "object" as const,
      properties: {
        path: { type: "string" as const, description: "Repo-relative path to write." },
        contents: { type: "string" as const, description: "Full file contents. This replaces whatever was there before." },
      },
      required: ["path", "contents"],
    },
  },
  {
    name: "justify_diff_overflow",
    description: "Call ONLY when your proposed change must exceed the graduality soft-cap (200 lines / 5 files). Without this call, an oversized diff is rejected by slowcook.",
    input_schema: {
      type: "object" as const,
      properties: {
        reason_category: {
          type: "string" as const,
          enum: ["new_module", "protocol_change", "cross_cutting", "refactor_needed", "other"],
        },
        affected_scope: {
          type: "array" as const,
          items: { type: "string" as const },
          description: "Paths or directories affected by the overflow.",
        },
        narrative: {
          type: "string" as const,
          description: "Concrete one-paragraph explanation of why the smaller diff isn't viable.",
        },
        proposed_substories_if_split: {
          type: "array" as const,
          items: { type: "string" as const },
          description: "If this story should be split, list the sub-stories here.",
        },
      },
      required: ["reason_category", "affected_scope", "narrative"],
    },
  },
];

/**
 * Render a single-turn prompt for the agent. Keeps history short (we re-supply
 * the same system prompt via prompt caching, then hand a fresh turn-state each
 * iteration; agent doesn't carry over its own previous turns because slowcook
 * may have reverted them).
 */
export function turnPrompt(args: {
  iteration: number;
  max_iterations: number;
  target_test_id: string;
  target_test_file: string;
  spec_yaml: string;
  currently_green: string[];
  currently_red: string[];
  allowed_paths: string[];
  budget_spent_usd: number;
  budget_cap_usd: number;
  previous_attempts?: Array<{
    iteration: number;
    outcome: "reverted-regression" | "reverted-no-progress" | "rejected-overflow";
    note: string;
    files_touched: string[];
  }>;
}): string {
  const sections: string[] = [];
  sections.push(`## Brew iteration ${args.iteration} of ${args.max_iterations}`);
  sections.push(
    `**Budget:** $${args.budget_spent_usd.toFixed(2)} spent of $${args.budget_cap_usd.toFixed(2)} cap.`
  );
  sections.push("");
  sections.push("### Target test (flip this one from red to green)");
  sections.push("```");
  sections.push(args.target_test_id);
  sections.push(`   (in ${args.target_test_file})`);
  sections.push("```");
  sections.push("");
  sections.push("### Spec (the contract)");
  sections.push("```yaml");
  sections.push(args.spec_yaml.trim());
  sections.push("```");
  sections.push("");
  if (args.allowed_paths.length > 0) {
    sections.push("### Allowed paths for this story");
    for (const p of args.allowed_paths) sections.push(`- \`${p}\``);
    sections.push("");
  }
  sections.push(
    `### Test state going into this turn: ${args.currently_green.length} green / ${args.currently_red.length} red`
  );
  sections.push("");
  if (args.currently_green.length > 0) {
    sections.push("<details><summary>Currently green (keep them green!)</summary>");
    sections.push("");
    for (const t of args.currently_green.slice(0, 30)) sections.push(`- \`${t}\``);
    if (args.currently_green.length > 30) {
      sections.push(`- … (${args.currently_green.length - 30} more)`);
    }
    sections.push("</details>");
    sections.push("");
  }
  if (args.previous_attempts && args.previous_attempts.length > 0) {
    sections.push("### Your previous attempts on this target");
    for (const a of args.previous_attempts.slice(-3)) {
      sections.push(`- **iter ${a.iteration}: ${a.outcome}** — ${a.note}`);
      if (a.files_touched.length > 0) {
        sections.push(`  files: ${a.files_touched.map((f) => `\`${f}\``).join(", ")}`);
      }
    }
    sections.push("");
  }
  sections.push("### Your turn");
  sections.push(
    "Use the tools to inspect the code, then write the minimum change that flips the target test. End with a one-paragraph rationale of what you changed and why."
  );
  return sections.join("\n");
}
