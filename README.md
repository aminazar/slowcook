# slowcook

> Turn a user story into frozen tests, then let an agent iterate until they're green — without letting it move the goalposts.

[![npm](https://img.shields.io/npm/v/@slowcook-ai/cli.svg)](https://www.npmjs.com/package/@slowcook-ai/cli)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)

> **Pre-1.0.** Commands, file layouts, and prompt contracts change between minor versions. Pin your version in `.brewing/slowcook-cli-version` and read [`CHANGELOG.md`](./CHANGELOG.md) before upgrading.

> **Using an AI agent with slowcook?** Point it at [AGENTS.md](./AGENTS.md) — pipeline overview, command reference, and the pitfalls that cost real money.

## What it is

Most AI coding tools optimize for time-to-first-screenshot. slowcook optimizes for code you can still trust next month.

The mechanism is a **ratchet**. Tests are written and frozen *before* the agent starts, and the agent cannot edit them. Every iteration is scored against them:

- A test flips red → green? **Commit it.** That's a checkpoint.
- A previously-green test breaks? **Revert the whole iteration.**
- Nothing changed? Keep the code as the next turn's base, but no checkpoint.

Progress can only go one direction. The agent can't skip a test, weaken an assertion, or declare success early, because it never holds the pen on the thing that defines success.

You approve the tests. The agent does the typing. You review roughly the 10% that needs taste.

## Install

```bash
npx @slowcook-ai/cli@latest init
```

Scaffolds `.brewing/` config, test helpers, and CI workflows into an existing project. Review what it generates, commit it, then set a key:

```bash
export ANTHROPIC_API_KEY=sk-ant-...
```

Or run on your Claude subscription instead of API billing:

```bash
export SLOWCOOK_LLM=claude-cli    # uses your local `claude` login
```

Subscription mode still records spend at API list price, so cost reporting keeps working.

**Requirements:** Node 20+, a git repo, and a test runner slowcook has an adapter for — TypeScript/Vitest or Solidity/Foundry.

## Quickstart

From a GitHub issue to merged, tested code:

```bash
slowcook refine --issue 42      # issue → clarifying questions → a frozen spec PR
                                # (you review and merge the spec)

slowcook recipe --spec 007      # spec → tests, as a PR
                                # (you review and merge the tests — this is the contract)

slowcook brew --story 007       # agent iterates until the tests pass
```

`brew` stops on its own: all-green, budget exhausted, iteration cap, or a halt it can explain. Either way you get a branch, a PR, and a report of every iteration with its cost.

Always cap the spend:

```bash
slowcook brew --story 007 --budget-usd 5 --max-iterations 10
```

## The commands you'll actually use

| Command | What it does |
|---|---|
| `init` | Scaffold slowcook into an existing repo |
| `refine --issue <n>` | Issue → clarified, frozen spec |
| `recipe --spec <id>` | Spec → tests (the contract) |
| `brew --story <id>` | Agent iterates until tests pass |
| `map generate` | Index the repo so the agent stops rediscovering it |
| `cost log` / `cost reprice` | Per-story spend accounting |
| `budget set --monthly 50` | Spend caps |
| `stories status` | Where every story is in the pipeline |
| `check prod-honesty` | Catch mock data leaking into production paths |
| `taste --pr <n> [--merge]` | Reviewer agent: verdict against the PR's full lineage; merges only where gates allow |
| `worker run` | Unattended loop: derives jobs from repo state, runs one per pass |
| `workload` | Read-only view of what the worker sees — every job, every precondition, what runs next |
| `doctor` | Verify and name every worker precondition (live checks, fail-closed) |
| `worker deploy --host <ssh>` | Ship slowcook to a worker box with a dist-freshness assertion |
| `app init` | One-click GitHub App so agents post as a bot, not as you |

Agents review each other, but `.brewing/gates.yaml` declares which merges
stay human — see [docs/worker.md](docs/worker.md) for the unattended
operating model (worker, taste, gates, review rounds).

Run `slowcook --help` for the full surface, or `slowcook <command> --help` for one command.

**Run `map generate` before your first brew.** Without it the agent spends its first iteration — often a dollar or more — opening files to learn a repo layout the map could have handed it up front.

## Concepts

**The spec is frozen.** Once merged, a spec is immutable. Changing it means an explicit `slowcook amend` with a reason, so scope drift leaves a trail instead of happening quietly.

**Tests are the contract.** `recipe` writes them, you approve them, and from then on they're the definition of done. Their quality bounds everything downstream — an agent will happily satisfy a weak test exactly as written.

**Iterations are cheap, checkpoints are earned.** A brew run may take many turns; only the ones that flip a test to green get committed.

**Spend is metered.** Every iteration writes a cost row, so a run that goes wrong is visible in dollars rather than discovered on your invoice.

## Beyond the core loop

The pipeline extends past the main three, when you need it:

- **Greenfield** — `menu` turns a PRD into a story set; `vibe` builds a clickable mock app (React over in-browser SQLite) to review before any backend exists.
- **Review** — [`@slowcook-ai/review-overlay`](./packages/review-overlay) lets reviewers annotate a running app; comments land as labelled GitHub issues.
- **Bugs** — `investigate → recipe --regression → sift` turns a bug report into a failing test, then a fix.
- **Brownfield** — `extract` and `recon` map an existing codebase so specs are written against what's actually there.

## Stacks

| Stack | Package | Test runner |
|---|---|---|
| TypeScript | `@slowcook-ai/stack-ts` | Vitest |
| Solidity | `@slowcook-ai/stack-solidity` | Foundry (`forge`) |

Adapters handle test discovery, running, result parsing, and lint. Adding a stack means implementing that interface — the core loop is language-neutral.

Suites parameterised by environment declare it in `.brewing/stack.json`:

```json
"test": { "forge": {
  "run_command": "forge test --root ../acceptance",
  "env": { "DOVIZIR_DEPLOYER": "src/arm/ArmBDeployer.sol:ArmBDeployer" }
}}
```

Values may reference the ambient environment as `${VAR}`, so secrets stay out of the repo.

## Packages

| Package | Version |
|---|---|
| [`@slowcook-ai/cli`](./packages/cli) | 0.31.0 |
| [`@slowcook-ai/core`](./packages/core) | 0.17.0 |
| [`@slowcook-ai/llm-anthropic`](./packages/llm-anthropic) | 0.24.0 |
| [`@slowcook-ai/stack-ts`](./packages/stack-ts) | 0.10.0 |
| [`@slowcook-ai/stack-solidity`](./packages/stack-solidity) | 0.2.0 |
| [`@slowcook-ai/forge-github`](./packages/forge-github) | 0.15.0 |
| [`@slowcook-ai/review-overlay`](./packages/review-overlay) | 0.25.6 |
| [`@slowcook-ai/gates`](./packages/gates) | 0.12.0 |

The CLI stays neutral: `forge-*` packages own the git host, `stack-*` packages own the language, `llm-*` owns the model.

## Contributing

```bash
pnpm install
pnpm build
pnpm -r exec vitest run
```

See [CONTRIBUTING.md](./CONTRIBUTING.md). Bug reports: [REPORTING.md](./REPORTING.md).

## License

MIT — see [LICENSE](./LICENSE).
