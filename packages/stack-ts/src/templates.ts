/**
 * Stack-specific scaffold templates consumed by `slowcook init`. Used to
 * live in `@slowcook-ai/cli/src/commands/init/templates.ts`, which meant
 * CLI shipped TypeScript/Vitest-specific assumptions despite slowcook's
 * stack-agnostic pledge. 0.7.0 Phase 1B moves them here so CLI stays
 * neutral.
 *
 * Future stack adapters (`@slowcook-ai/stack-python`, `@slowcook-ai/stack-go`)
 * implement their own equivalents returning pytest / go-test / cargo-test
 * configuration. CLI's init composes the stack's contribution with the
 * forge's contribution and its own forge/stack-neutral core.
 */

export interface TsStackInitParams {
  /** Whether the consumer project has Playwright installed (affects the $doc note). */
  hasPlaywright: boolean;
}

/**
 * `.brewing/stack.json` — tells slowcook how to discover + run tests in a
 * Vitest-based TypeScript project. Callers merge with forge and core
 * contributions at init time.
 */
export function getTsStackConfig(params: TsStackInitParams): string {
  const doc =
    "Project-level stack configuration consumed by slowcook (@slowcook-ai/stack-ts). " +
    "Tells the harness how to discover and run tests. Only include suites that are " +
    "actually runnable — slowcook refuses to record an incomplete manifest." +
    (params.hasPlaywright
      ? " (Playwright detected in package.json; slowcook's playwright discovery is not yet " +
        "implemented, so the e2e suite is intentionally omitted. Add it back post-upgrade.)"
      : "");

  return (
    JSON.stringify(
      {
        $schema: "./stack.schema.json",
        $doc: doc,
        language: "typescript",
        package_manager: "npm",
        test: {
          backend: {
            runner: "vitest",
            run_command: "npx vitest run",
            discover_command: "npx vitest list",
            reporter_format: "vitest-list-lines",
          },
        },
        lint: {
          lint_command: "npm run lint",
          typecheck_command: "npm run typecheck",
        },
      },
      null,
      2
    ) + "\n"
  );
}

/**
 * Files the TS stack wants frozen in the consumer's `.brewing/frozen-paths.json`.
 * Composed with the forge adapter's and core's own frozen paths at init time.
 */
export function getTsStackFrozenFiles(): string[] {
  return ["vitest.config.ts", "vitest.config.mjs", "vitest.config.js"];
}

/** Stable identifier for this stack. */
export const STACK_ID = "typescript" as const;
