// Project constitution — the law file every agent stage loads (S1,
// docs/plans/spec-kit-borrowings.md; issue #526). Adapts the
// constitution idea from GitHub's Spec Kit (github/spec-kit, MIT) with
// slowcook discipline: three-state decision slots (ticked /
// deliberately-blank-with-justification / unaddressed), lazy fill,
// git as the only version history.
//
// The loader is deliberately dumb: read the file, wrap it in an
// enforcement preamble, return one string for prompt injection. No
// parsing, no caps, no summarization — the file is law as written.

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { execSync } from "node:child_process";

export const CONSTITUTION_PATH = ".brewing/constitution.md";

/** Enforcement semantics injected above the file content. The three
 *  sentences carry the three slot states. */
const PREAMBLE = `### Project constitution (\`.brewing/constitution.md\`)

The constitution supersedes informal practices and code precedent. When
a decision or finding touches a slot below: follow it and CITE it. A
slot marked **deliberately blank** is a recorded deferral — do NOT flag
or fix its concern; the silence is the ruling. A slot that is
unaddressed and material to your task: raise it as ONE clarifying
question rather than assuming an answer.`;

/** Raw file content, or null when the project has no constitution. */
export function loadConstitution(repoRoot: string): string | null {
  const p = join(repoRoot, CONSTITUTION_PATH);
  if (!existsSync(p)) return null;
  const text = readFileSync(p, "utf8").trim();
  return text.length > 0 ? text : null;
}

/** Prompt block: preamble + file, or "" when absent (callers append
 *  unconditionally; an empty string is a no-op). */
export function constitutionBlock(repoRoot: string): string {
  const text = loadConstitution(repoRoot);
  if (!text) return "";
  return `\n\n${PREAMBLE}\n\n${text}\n`;
}

const TEMPLATE = `# Constitution

<!-- Adapted from Spec Kit (https://github.com/github/spec-kit, MIT):
     the constitution artifact, re-shaped into three-state decision
     slots. See docs/plans/spec-kit-borrowings.md in slowcook. -->

This file supersedes informal practices and code precedent. Slots are
filled LAZILY — when a decision is first hit (an arbitration, a clarify
answer, a review finding) — never speculatively. A deliberately blank
slot is law too: agents must not flag its concern.

## Slots

<!-- Three states per slot:
     [x] ticked — rule active; agents enforce and cite it.
     [-] deliberately blank — deferral WITH justification/by/at and an
         optional revisit trigger; agents stay silent on the concern.
     [ ] unaddressed — nobody decided; agents escalate on first
         material contact, exactly once. -->

- [ ] Contract-conflict priority (who wins when merged artifacts disagree)
- [ ] Access-control posture for new tables/surfaces
- [ ] Data migration conventions (numbering, collision policy)
- [ ] Atomicity idiom for cross-entity writes
- [ ] Test-tier doctrine (what proves schema truth vs behavior)
- [ ] Time/week bucketing conventions
- [ ] Copy voice and brand constants

## Rulings

<!-- Append-only. Every entry: date, verbatim ruling (quoted, never
     paraphrased), source link. Slot-less rulings live here and may
     graduate into a slot. -->
`;

/** Create the template file. Refuses to overwrite. */
export function initConstitution(repoRoot: string): { created: boolean; path: string } {
  const p = join(repoRoot, CONSTITUTION_PATH);
  if (existsSync(p)) return { created: false, path: p };
  writeFileSync(p, TEMPLATE, "utf8");
  return { created: true, path: p };
}

export interface RuleAddArgs {
  repoRoot: string;
  text: string;
  source?: string;
  by?: string;
  now?: () => Date;
}

/** Append one ruling line. An echo>> with a provenance stamp — the
 *  caller commits. Requires the file (run `slowcook rule init` first). */
export function addRuling(args: RuleAddArgs): string {
  const p = join(args.repoRoot, CONSTITUTION_PATH);
  if (!existsSync(p)) {
    throw new Error(
      `${CONSTITUTION_PATH} not found — run \`slowcook rule init\` first.`
    );
  }
  const by = args.by ?? gitUserName(args.repoRoot) ?? "unknown";
  const date = (args.now?.() ?? new Date()).toISOString().split("T")[0];
  const source = args.source ? ` — ${args.source}` : "";
  const line = `- ${date} (${by}): "${args.text.trim()}"${source}\n`;
  const current = readFileSync(p, "utf8");
  const updated = current.endsWith("\n") ? current + line : current + "\n" + line;
  writeFileSync(p, updated, "utf8");
  return line.trim();
}

function gitUserName(repoRoot: string): string | null {
  try {
    const name = execSync("git config user.name", {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return name || null;
  } catch {
    return null;
  }
}
