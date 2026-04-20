# @slowcook-ai/stack-ts

TypeScript/JavaScript stack adapter for the slowcook brewing harness.

This package translates between slowcook's stack-agnostic core and the specifics of JS/TS test tooling (currently Vitest; Playwright coming in a later release).

## What's in 0.2

- **`validateStackConfig(raw)`** — validates a parsed `.brewing/stack.json` against the shape the adapter expects.
- **`parseVitestList(output)`** — parses the plain-text output of `vitest list` (one `<file> > <describe-chain> > <test>` per line) into `TestEntry[]`.
- **`parsePlaywrightList(output)`** — stub; throws with a clear "coming later" message.
- **`parseByReporterFormat(format, output)`** — dispatches on `reporter_format` from stack.json.
- **`discoverTests(config, options)`** — runs every declared test suite's `discover_command`, parses the output, returns a unified `TestEntry[]` plus per-suite records and any errors.

The **only** supported `reporter_format` in 0.2 is `vitest-list-lines` (with `vitest-json` accepted as an alias for early adopters). `playwright-list-lines` is reserved; a non-stub implementation ships in a later release.

## Usage

```ts
import { discoverTests, validateStackConfig } from "@slowcook-ai/stack-ts";
import { readFileSync } from "node:fs";

const config = validateStackConfig(JSON.parse(readFileSync(".brewing/stack.json", "utf8")));
const { tests, suites, errors } = discoverTests(config, { cwd: process.cwd() });
```

If all you need is manifest record/verify from the command line, use `@slowcook-ai/cli` — it's a thin wrapper around this package.

## License

MIT
