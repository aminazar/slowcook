/**
 * WHICH STACK IS THIS, AND CAN THE COMMAND SERVE IT? (dovizir handover §8)
 *
 * `slowcook testgen --spec 002` on a `language: "solidity"` project happily
 * emitted `tests/integration/story-002.test.ts` — a vitest file the configured
 * runner (forge) can never discover. The stack dispatch added for brew/sift/
 * manifest simply did not reach testgen, and nothing checked.
 *
 * Emitting artifacts for the wrong runner is worse than refusing: the operator
 * gets a green-looking command, a committed file, and a failure much later at
 * a place that does not name the cause. So: read the declared language and
 * refuse loudly when a command cannot serve it.
 *
 * Deliberately dependency-free — it reads `.brewing/stack.json` directly
 * rather than importing a stack adapter, so it works in a CLI that has only
 * `stack-ts` installed as well as one that has more.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

/** The declared language, or null when there is no readable stack.json. */
export function declaredLanguage(repoRoot: string, stackConfigPath = ".brewing/stack.json"): string | null {
  try {
    const raw = readFileSync(join(repoRoot, stackConfigPath), "utf8");
    const lang = (JSON.parse(raw) as { language?: unknown }).language;
    return typeof lang === "string" && lang.trim() ? lang.trim().toLowerCase() : null;
  } catch {
    return null;
  }
}

/** Languages whose test artifacts the TS toolchain can actually emit. */
export const TS_LANGUAGES = ["typescript", "javascript"] as const;

export function isTsLanguage(lang: string | null): boolean {
  return lang === null || (TS_LANGUAGES as readonly string[]).includes(lang);
}

/**
 * Message for a command that can only emit TS/vitest artifacts being pointed
 * at another stack. Pure, so the wording is testable.
 */
export function unsupportedStackMessage(command: string, lang: string): string {
  return (
    `slowcook ${command}: this project declares language "${lang}", and ${command} can only emit TypeScript/vitest artifacts.\n` +
    `  Generating them anyway would write test files your configured runner can never discover.\n` +
    `  Stack-aware commands today: brew, sift, manifest. Write the ${lang} tests by hand for now, then \`slowcook manifest record\` them.`
  );
}

/**
 * Guard for TS-only emitters. Returns normally for TS/JS (or no stack.json —
 * a repo that never ran `init` is not asserting anything). Exits 78
 * (EX_CONFIG) otherwise: a configuration mismatch, not a crash.
 */
export function requireTsStack(command: string, repoRoot: string, stackConfigPath?: string): void {
  const lang = declaredLanguage(repoRoot, stackConfigPath);
  if (isTsLanguage(lang)) return;
  console.error(unsupportedStackMessage(command, lang!));
  process.exit(78);
}
