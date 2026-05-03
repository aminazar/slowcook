import type { TestEntry } from "@slowcook-ai/core";

/**
 * Parse vitest's `list` subcommand output. Each non-empty line is a test in
 * the format:
 *
 *     <file> > <describe-1> [> <describe-N>]... > <test-name>
 *
 * The file is the left-most segment; the test id is the entire line.
 */
export function parseVitestList(output: string): TestEntry[] {
  const entries: TestEntry[] = [];
  for (const rawLine of output.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    // The separator `>` may itself appear inside a test name — but by vitest's
    // convention the first " > " separates file from path, and we only need
    // to extract the file portion.
    const sepIdx = line.indexOf(" > ");
    if (sepIdx === -1) {
      // Lines that don't match the format (stray stderr, warnings) are skipped.
      // We don't want a noisy stderr line to become a bogus test id.
      continue;
    }
    const file = line.slice(0, sepIdx).trim();
    if (!file) continue;
    entries.push({ id: line, file });
  }
  return entries;
}

/**
 * Playwright list output parser. Stub — full discovery support lands
 * in a later release. Until then, returns [] (no discovered tests for
 * this suite) and logs a notice. Same degrade-don't-halt pattern as
 * brew α.28 — a stack.json declaring an unsupported suite shouldn't
 * block manifest verify on suites slowcook CAN discover.
 *
 * Consumers who need Playwright in the manifest today: either wait
 * for the parser implementation OR write a thin wrapper that emits
 * vitest-list-lines from playwright (via a custom reporter).
 */
export function parsePlaywrightList(_output: string): TestEntry[] {
  if (typeof console !== "undefined") {
    console.warn(
      "[stack-ts] parsePlaywrightList: discovery not implemented; suite returns [] tests."
    );
  }
  return [];
}

export function parseByReporterFormat(
  format: string,
  output: string
): TestEntry[] {
  switch (format) {
    case "vitest-list-lines":
    // For 0.1 compatibility, also accept the older name users may have in stack.json.
    case "vitest-json":
      return parseVitestList(output);
    case "playwright-list-lines":
    case "playwright-list":
    // For compat with stack.json files written before 0.17.0-alpha.3
    // when the template inadvertently emitted `playwright-list` (the
    // parser only ever knew `playwright-list-lines`). Accept both.
    case "playwright-json":
      return parsePlaywrightList(output);
    default:
      throw new Error(
        `Unknown reporter_format: ${JSON.stringify(format)}. ` +
          `Supported: vitest-list-lines, playwright-list-lines (or alias playwright-list).`
      );
  }
}
