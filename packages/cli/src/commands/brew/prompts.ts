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

- **find_handler({ method, path })** — **call this FIRST for every \`api_contract\` entry in the spec.** Returns the exact handler file + function the brewing agent should edit (e.g. \`POST /api/rewos\` → \`src/app/api/rewos/route.ts\` :: \`POST\`). Saves the exploratory iteration where you'd otherwise grep for the route.
- **outline_file(path)** — **prefer this over read_file for initial exploration.** Returns a compact outline (imports, top-level exports, signatures with line numbers) — ~200 tokens. Use this to decide whether a file is relevant before you read it fully.
- **read_file(path)** — read a file's full contents. Only call this when you need to see inside a specific function body that outline_file flagged. Reading a file you don't need is the single biggest driver of wasted budget.
- **list_directory(path)** — see what's in a directory. Useful when outline_file + find_handler don't give enough.
- **write_file(path, contents)** — create or fully replace a file. Always read or outline first, then write the complete updated contents.
- **justify_diff_overflow({ reason_category, affected_scope, narrative, proposed_substories_if_split? })** — call ONLY if your intended change must exceed the graduality soft-cap (200 lines across ≤5 files). Explain why.

You do NOT run tests. Slowcook runs them after your turn and tells you the result in the next turn's prompt.

## Exploration strategy (cheap first, expensive last)

**Start every turn by reading \`.brewing/code-map.json\`** (or its rendered
sibling \`.brewing/code-map.md\`). Slowcook regenerates that file before
each iteration — it's the up-to-date list of every API route, page,
component, helper, and domain type in the project, with JSDoc summaries,
file paths, and signatures. Think of it as the project's self-updating
Swagger-for-everything. One \`read_file\` on it replaces a dozen exploratory
reads.

Then, in order:

1. **Code map first** — \`read_file('.brewing/code-map.json')\`. Skim to
   see what already exists.
2. For each api_contract entry relevant to the target test, **find_handler**
   to confirm the exact file + function (the code map also has this, but
   find_handler is a one-call shortcut).
3. **outline_file** on each file the code map / find_handler points to,
   plus obvious neighbours (utils, types, helpers the spec references).
4. **read_file** only the specific files + functions the outline flagged
   as needing changes.
5. **write_file** the minimum change.

A human doesn't read every file in a package to fix one test; neither should you.

## When you're stuck (same target, 2+ iterations without progress)

**Check the \`Why the target failed last run\` section in every turn prompt FIRST.** The test's \`Received:\` / error message tells you what the assertion actually saw — that's ground truth. Don't spend iterations re-reading your own code looking for a bug you missed when the failure message is right there.

**Specific anti-pattern to avoid:** "the code LOOKS like it shouldn't render X, but the test says X is in the document" — do NOT interpret this as "there must be a subtle JSX evaluation bug." It almost always means another element matches the same query selector. Read the \`Received:\` payload to see which element the selector hit.

**If after reading the failure message you genuinely can't tell what's in the DOM:** insert a \`console.log(screen.debug())\` in the test file OR a distinctive \`data-testid="probe-iter-N"\` attribute in the component as a **one-iteration diagnostic**. The ratchet will revert your change (it's not a green gain), and on the NEXT iteration's prompt you'll see the DOM output in the failure message. Diagnostic probing is cheap; analysis paralysis is expensive.

**If you still can't reconcile after 3 iterations on the same target — halt voluntarily.** End your rationale with a new line containing exactly:

\`\`\`
Considering halting voluntarily
\`\`\`

Followed by a concrete description of the specific mismatch you can't resolve (e.g. "test queries getByRole('alert'); my component has one \`role=\"alert\"\` element gated on \`!handle_confirmed\`; I can't see what's in the rendered DOM when handle_confirmed=true."). Slowcook will halt immediately and surface your description to the operator. This saves ~15 iterations of silent spending; the operator picks up the diagnostic you handed them and either hand-patches the blocker or clarifies the spec.

## Schema-assertion tests (target file lives under \`tests/schema/\`)

When the target test is a schema assertion (path \`tests/schema/story-N.test.ts\`), it reads \`supabase/migrations/*.sql\` and asserts specific columns appear. Constraints:

- **Write a new migration file** — never edit an existing one. Pick the next unused number (\`NNNNN_\` prefix, zero-padded to match neighbours): \`list_directory supabase/migrations/\`, find the max, add 1.
- **Minimal DDL** — just \`ALTER TABLE <t> ADD COLUMN <c> <type> ...;\`. If the test asserts multiple columns, one migration file can add several in a single \`ALTER TABLE\` with comma-separated clauses, or multiple statements in the same file.
- **Spec invariants drive the TYPE / constraints** (e.g. "boolean not null default false", "timestamptz nullable"). The schema-assertion test only checks NAME, not type — but the invariants must still be honoured by the migration you write.
- **Backfill if invariants require it** — if an invariant says "...and backfills existing rows to false", write an \`UPDATE\` in the same migration, or use \`DEFAULT\` on \`ADD COLUMN\` to cover both new + existing rows in one shot.
- **Never touch \`supabase/migrations/00001_*\`** through whatever number exists — those are historical. Append-only is the convention.

## Page-link assertion (target file ends in \`-page.test.ts\` under \`tests/integration/\`)

When the target test is a page-link assertion, it reads a Next.js page file and asserts the page IMPORTS + MOUNTS a named component. Fix by editing the page:

- **Add the import** from the specifier the test names (\`@/components/...\`).
- **Render the component** in the page's JSX (\`<ComponentName .../>\` or \`<ComponentName>...children...</ComponentName>\`).
- **If the page is a server component fetching data**, pass the fetched data to the component as a prop. Don't convert the page to a client component to avoid the fetch — that breaks the rest of the page.
- **Existing layout stays** — don't refactor unrelated sections. Wedge the component in alongside what's already there (a new \`<section>\` block is typical).

## UI component tests (tier-1 UI, target file ends in \`.test.tsx\`)

When the target test is a UI component test (file path ends in \`-ui.test.tsx\`), you're editing React/TSX — typically \`src/components/**/*.tsx\` or client pages at \`src/app/**/page.tsx\`. Constraints:

- **Import path is the single source of truth** — the test file imports the component from some path; create / edit the file at that path. Don't rename.
- **Stubs you find with a \`@slowcook-stub\` marker on line 1 are yours to replace.** Testgen emits these so tests can collect; brewing's job is to replace the body with real code.
- **Helpers under \`tests/helpers/\` (e.g. \`renderWithProviders\`, \`mockFetch\`, \`realShapedFetch\`, \`axe\`) are fixed test infra** — never edit them. If a test imports from there, trust the import.
- **Mocked \`fetch\` via \`vi.stubGlobal\`** means your component calls \`fetch("/api/…")\` like normal; the mock intercepts. Don't add branching for test-mode — call fetch cleanly in production shape.
- **Accessibility asserts** (the mandatory axe test) care about semantic HTML — use \`<main>\`, \`<nav>\`, \`<button>\`, \`<label htmlFor>\`, proper heading hierarchy, \`aria-*\` attributes where needed. A non-accessible component fails the axe test.
- **\`"use client"\` directive** at the top of the file when the component uses hooks (useState, useEffect, onClick handlers, etc.). Next.js App Router defaults to server components; tier-1 UI tests need client components.
- **Props types** come from the spec + the test file's usage. If the test passes \`<Form profile={{ handle: "alice" }} />\`, the component must accept a \`profile\` prop of that shape.
- **Match the project's visual conventions.** Tier-1 tests query by role/label/text and don't assert styling — but the user STILL has to look at what you ship. A component with zero \`className\` attributes is incomplete even if every test passes. Read \`.brewing/context.md\` for the project's design-token names + reusable class patterns (buttons, inputs, alerts, labels) before writing the component body. If context.md is silent on styling, imitate neighbouring files in \`src/components/\` / \`src/app/(main)/\` — match their spacing, border, focus-ring, and colour-token choices.

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
    name: "find_handler",
    description:
      "Resolve an API spec entry (method + path) to its concrete handler file + function. Use this FIRST for every api_contract entry in the spec — it replaces an exploratory read/list cycle. Today supports Next.js App Router (detected by `src/app/`); other frameworks return `framework: 'unknown'`. Returns JSON with { framework, file, function, exists, note? }.",
    input_schema: {
      type: "object" as const,
      properties: {
        method: {
          type: "string" as const,
          description: "HTTP method, e.g. 'POST', 'GET', 'DELETE'.",
        },
        path: {
          type: "string" as const,
          description: "URL path, with params as `:id` or `{id}` — both are normalised (e.g. '/api/rewos/:rewo_id/reports' → 'src/app/api/rewos/[rewo_id]/reports/route.ts').",
        },
      },
      required: ["method", "path"],
    },
  },
  {
    name: "outline_file",
    description:
      "Return a compact outline of a TypeScript/JavaScript file: imports, top-level exports, signatures with line numbers. ~200 tokens. PREFER this over read_file for initial exploration — only call read_file when the outline tells you a specific function body needs to be inspected.",
    input_schema: {
      type: "object" as const,
      properties: {
        path: {
          type: "string" as const,
          description: "Repo-relative path (e.g., 'src/app/api/reactions/route.ts').",
        },
      },
      required: ["path"],
    },
  },
  {
    name: "read_file",
    description: "Read a file's full contents. Call this AFTER outline_file tells you a specific file / function body needs to be inspected — reading files you don't need is the single biggest driver of wasted budget. Returns the full file (up to 20k chars).",
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
  /** 0.7.14 Fix 1: the target test's failure message from the most
   * recent run. Includes vitest's assertion output — crucially, the
   * `Received:` payload for UI tests showing what was actually in the
   * DOM vs what the test expected. Without this the agent reasons
   * abstractly about its own code and can't reconcile with the test
   * verdict (observed as paralysis on rewo story-006). */
  target_failure_message?: string;
  /** 0.7.14 Fix 1: failure messages for OTHER red story tests (not the
   * target). Shown truncated so the agent has peripheral vision into
   * related problems without losing focus on the target. */
  other_failure_messages?: Array<{ test_id: string; message: string }>;
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

  // Fix 1 (0.7.14): the failure message is the single highest-leverage
  // piece of data for avoiding analysis paralysis. Vitest's output includes
  // the `Received:` payload (e.g., the actual DOM snippet for UI tests) —
  // without this the agent reasons about abstract code instead of
  // observed reality.
  if (args.target_failure_message) {
    sections.push("### Why the target failed last run");
    sections.push("```");
    sections.push(args.target_failure_message.trim());
    sections.push("```");
    sections.push("");
    sections.push(
      "Read the `Received:` / error message CAREFULLY before inspecting code. The test's verdict is ground truth; your mental model of the code is not."
    );
    sections.push("");
  }
  if (args.other_failure_messages && args.other_failure_messages.length > 0) {
    sections.push(
      "<details><summary>Other red tests' failure messages (peripheral vision)</summary>"
    );
    sections.push("");
    for (const f of args.other_failure_messages.slice(0, 5)) {
      sections.push(`**\`${f.test_id}\`:**`);
      sections.push("```");
      sections.push(f.message.slice(0, 400));
      sections.push("```");
      sections.push("");
    }
    if (args.other_failure_messages.length > 5) {
      sections.push(`_+ ${args.other_failure_messages.length - 5} more red tests._`);
    }
    sections.push("</details>");
    sections.push("");
  }
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
