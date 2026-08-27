// `slowcook rule` — manage the project constitution (S1, #526).
//
//   slowcook rule init                      create .brewing/constitution.md
//   slowcook rule add "<text>" [--source <url>] [--by <name>] [--cwd <path>]
//
// `add` is an echo>> with a provenance stamp; committing stays with the
// caller's flow. Adapted from Spec Kit's constitution idea
// (github/spec-kit, MIT) — see docs/plans/spec-kit-borrowings.md.

import {
  initConstitution,
  addRuling,
  CONSTITUTION_PATH,
} from "../lib/constitution.js";

export async function rule(argv: string[]): Promise<void> {
  const sub = argv[0];
  let cwd = process.cwd();
  let source: string | undefined;
  let by: string | undefined;
  const positional: string[] = [];
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i]!;
    const next = argv[i + 1];
    if (a === "--cwd" && next) { cwd = next; i++; }
    else if (a === "--source" && next) { source = next; i++; }
    else if (a === "--by" && next) { by = next; i++; }
    else if (a === "--help" || a === "-h") { printHelp(); return; }
    else positional.push(a);
  }

  if (sub === "init") {
    const res = initConstitution(cwd);
    if (res.created) {
      console.log(`Created ${CONSTITUTION_PATH} — fill slots lazily; commit it.`);
    } else {
      console.log(`${CONSTITUTION_PATH} already exists — not touched.`);
    }
    return;
  }

  if (sub === "add") {
    const text = positional[0];
    if (!text) {
      console.error('usage: slowcook rule add "<verbatim ruling>" [--source <url>]');
      process.exitCode = 64;
      return;
    }
    try {
      const line = addRuling({ repoRoot: cwd, text, source, by });
      console.log(`Appended to ${CONSTITUTION_PATH}:\n  ${line}\nCommit it to make it law.`);
    } catch (e) {
      console.error(e instanceof Error ? e.message : String(e));
      process.exitCode = 2;
    }
    return;
  }

  printHelp();
  process.exitCode = sub ? 64 : 0;
}

function printHelp(): void {
  console.log(`
slowcook rule — manage the project constitution (.brewing/constitution.md)

Usage:
  slowcook rule init
  slowcook rule add "<verbatim ruling>" [--source <url>] [--by <name>] [--cwd <path>]

The constitution is loaded into every agent stage's prompt (refine,
taste, brew, sift, plate). Rulings are recorded VERBATIM — quote, never
paraphrase. Slots have three states: ticked, deliberately blank (with
justification — agents stay silent), unaddressed (agents escalate once).
`);
}
