# @slowcook-ai/stack-solidity

Solidity/Foundry stack adapter for [slowcook](https://github.com/aminazar/slowcook).
Sibling of `@slowcook-ai/stack-ts` — same adapter surface, forge-flavoured:

- **Discovery** — `forge test --list --json` → the same `DiscoveryResult`
  shape manifest record/verify consumes.
- **Run** — `forge test --json` → `RunResult`/`TestResult` rows (unit, fuzz
  with runs/mean-gas, failures with reason + counterexample). Compilation
  errors surface as `ran: false` with the compiler excerpt.
- **Lint** — `forge fmt --check` (default) adapted to the same `LintResult`
  shape brew's iteration loop reads. Solidity has no separate typecheck
  channel — solc runs inside `forge test`.
- **Gas ratchet** — `checkGasSnapshot` runs `forge snapshot --check` and
  parses regressions into `{ test, old, new, delta }`; `updateGasSnapshot`
  re-baselines.
- **Templates** — `getSolidityStackConfig` emits the `.brewing/stack.json`
  scaffold for `slowcook init` on a Foundry project.

`.brewing/stack.json` shape:

```json
{
  "language": "solidity",
  "test": {
    "forge": {
      "runner": "forge",
      "run_command": "forge test --json",
      "discover_command": "forge test --list --json",
      "reporter_format": "forge-json"
    }
  },
  "lint": { "lint_command": "forge fmt --check" },
  "gas_snapshot": { "snapshot_command": "forge snapshot", "snapshot_file": ".gas-snapshot" }
}
```

Tests run against committed fixtures captured from real forge 1.3.2 output
(`fixtures/`), so the suite never needs Foundry installed. A true
end-to-end test is gated behind `FORGE_E2E=1`.
