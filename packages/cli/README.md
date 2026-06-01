# @slowcook-ai/cli

The `slowcook` CLI — TDD-first agentic development harness. Turns a detailed user story into frozen tests, then lets agents iterate under strict guardrails until every test is green.

> ⚠️ **Active development — expect breaking changes.** Slowcook is pre-1.0 and the architecture itself is iterating in public. CLI commands, file layouts, prompt contracts, and the package surface can and will change between point versions.
>
> If you're adopting slowcook today: pin exact versions in your consumer (`.brewing/slowcook-cli-version`), read each release entry in [the changelog](https://github.com/aminazar/slowcook/blob/main/CHANGELOG.md) before bumping, and treat it as a partnership — feedback from real consumers is what drives the next cut.

## Install

```bash
npm i -D @slowcook-ai/cli
```

Or pin a specific version (recommended for consumers):

```bash
npm i -D @slowcook-ai/cli@0.19.5
```

The `latest` tag points at the most recent stable cut. Stamp your pinned version in `.brewing/slowcook-cli-version` after `slowcook init`.

## Start here

If you're an AI agent (Claude Code, Cursor, etc.) or a developer driving slowcook in a consumer repo, the canonical pipeline reference is **[AGENTS.md](https://github.com/aminazar/slowcook/blob/main/AGENTS.md)** at the repo root. It has the decision tree, the pipeline at a glance, per-command quick reference, and an empirical pitfalls list that saves real money + time on your first session.

This README covers install + the top-level command surface. AGENTS.md covers WHEN to reach for which command, the pipeline flow, and the failure modes you're likely to hit.

## Quick command reference

The pipeline is **refine → testgen → vibe → plate → recipe → brew → chef**. Each stage is an agent invocation that consumes the previous stage's output + commits its own PR.

```bash
# Pipeline (agent-driven)
npx slowcook refine            # GitHub issue → frozen spec PR
npx slowcook testgen           # spec → failing test PR
npx slowcook vibe              # spec → mockup PR
npx slowcook plate             # mockup + tests → review-overlay annotations
npx slowcook recipe            # tests + mockup → brew manifest
npx slowcook brew              # iterate src/ until all tests pass
npx slowcook chef              # post-merge drift-fix / orchestration

# Setup + plumbing
npx slowcook init              # scaffold .brewing/ + .github/workflows/ in a consumer repo
npx slowcook refresh-knowledge # rebuild .brewing/repo-knowledge/ (auto digests + git-history mining)
npx slowcook upsert-agent-docs # write the managed AGENTS.md block in consumer

# Guards + checks
npx slowcook guard             # frozen-paths check between two refs (CI)
npx slowcook manifest verify   # confirm the recorded test set still resolves
npx slowcook check spec        # re-run refine validators on a spec yaml (PR-amendment safety)
npx slowcook recon             # pre-brew structural backstop

# Knowledge + accounting
npx slowcook knowledge add     # add a curated entry to .brewing/repo-knowledge/curated/
npx slowcook cost log          # stamp a cost marker on a story (non-Actions agents)
```

Run `npx slowcook <command> --help` for per-command flags. All commands accept `--cwd <path>` to operate against a directory other than `.`.

## Required environment

Most pipeline commands invoke the Anthropic API and act on GitHub:

- `ANTHROPIC_API_KEY` — LLM calls (refine, testgen, vibe, plate, recipe, brew, chef)
- `GITHUB_TOKEN` — `contents: write`, `issues: write`, `pull-requests: write` for PR + comment work

`slowcook init`, `guard`, `manifest`, and `check` run locally without API/network access.

## What ships in this package

- `slowcook` binary (entry point: `dist/cli.js`)
- Pipeline commands listed above
- Programmatic API exports for the validators (`validateEntityFieldReferences`, `validateComponentReuseShape`, `validateRouteCollisions`, `validatePlateDtoColumns`) — useful if you want to wire the lint chain into a custom CI

The companion packages (`@slowcook-ai/core`, `@slowcook-ai/llm-anthropic`, `@slowcook-ai/forge-github`, `@slowcook-ai/stack-ts`, `@slowcook-ai/mock-runtime`) install transitively as workspace deps. The cli is the only one you `npm i` directly.

## License

MIT
