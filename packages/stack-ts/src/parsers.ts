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
/**
 * 2026-08-23 — real implementation (was a stub returning []). Parses
 * `npx playwright test --list` lines:
 *   `  [chromium-desktop] › tests/acceptance/story-005.spec.ts:21:7 › describe › title`
 * Id shape mirrors vitest ("<file> > <titles...>") with the project
 * appended, and MUST match parsePlaywrightRunJson's ids — the manifest
 * (discovery) and the runner (results) meet on these strings.
 */
export function parsePlaywrightList(output: string): TestEntry[] {
  const entries: TestEntry[] = [];
  const line = /^\s*\[([^\]]+)\]\s*›\s*(.+?):\d+:\d+\s*›\s*(.+)$/;
  for (const raw of output.split("\n")) {
    const m = raw.match(line);
    if (!m) continue;
    const project = m[1]!.trim();
    const file = m[2]!.trim();
    const titles = m[3]!.split("›").map((t) => t.trim()).filter(Boolean);
    entries.push({
      id: `${file} > ${titles.join(" > ")} [${project}]`,
      file,
    });
  }
  return entries;
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
    // tap-prove (2026-08-22, rewo pgTAP gating): discovery output is one
    // test FILE per line (e.g. `ls supabase/tests/database/*.test.sql`);
    // the file path is both id and name — pg_prove reports per-file.
    case "tap-prove":
      return output
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l && !l.startsWith("#"))
        .map((file) => ({ id: file, file }));
    default:
      throw new Error(
        `Unknown reporter_format: ${JSON.stringify(format)}. ` +
          `Supported: vitest-list-lines, playwright-list-lines (or alias playwright-list).`
      );
  }
}
