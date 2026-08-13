/**
 * Stack-specific scaffold templates consumed by `slowcook init` for
 * Foundry projects. Mirrors @slowcook-ai/stack-ts's templates.ts —
 * stack adapters own their stack.json contribution so CLI stays
 * stack-neutral; init composes the stack's contribution with the
 * forge (VCS) adapter's contribution and its own neutral core.
 */

export interface SolidityStackInitParams {
  /** Whether to include the gas-snapshot ratchet block (projects that commit .gas-snapshot). */
  hasGasSnapshot: boolean;
}

/**
 * `.brewing/stack.json` — tells slowcook how to discover + run tests in
 * a Foundry-based Solidity project. Callers merge with forge and core
 * contributions at init time.
 */
export function getSolidityStackConfig(params: SolidityStackInitParams): string {
  const doc =
    "Project-level stack configuration consumed by slowcook (@slowcook-ai/stack-solidity). " +
    "Tells the harness how to discover and run tests. Only include suites that are " +
    "actually runnable — slowcook refuses to record an incomplete manifest." +
    (params.hasGasSnapshot
      ? " (gas_snapshot enables the gas ratchet: brew treats `forge snapshot --check` " +
        "regressions as a hard signal. Re-baseline with `forge snapshot` when a gas " +
        "increase is intentional.)"
      : "");

  return (
    JSON.stringify(
      {
        $schema: "./stack.schema.json",
        $doc: doc,
        language: "solidity",
        test: {
          forge: {
            runner: "forge",
            run_command: "forge test --json",
            discover_command: "forge test --list --json",
            reporter_format: "forge-json",
          },
        },
        lint: {
          lint_command: "forge fmt --check",
        },
        ...(params.hasGasSnapshot
          ? {
              gas_snapshot: {
                snapshot_command: "forge snapshot",
                snapshot_file: ".gas-snapshot",
              },
            }
          : {}),
      },
      null,
      2
    ) + "\n"
  );
}

/**
 * Files the Solidity stack wants frozen in the consumer's
 * `.brewing/frozen-paths.json`. Composed with the forge adapter's and
 * core's own frozen paths at init time. foundry.toml controls compiler
 * + test settings; .gas-snapshot is the ratchet baseline — brew must
 * not rewrite either to make a red signal go away.
 */
export function getSolidityStackFrozenFiles(): string[] {
  return ["foundry.toml", ".gas-snapshot", "remappings.txt"];
}

/** Directories the Solidity stack freezes. Vendored deps are never brew-editable. */
export function getSolidityStackFrozenDirectories(): string[] {
  return ["lib/"];
}

/** Stable identifier for this stack. */
export const STACK_ID = "solidity" as const;
