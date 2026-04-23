# @slowcook-ai/recorder

Record / replay / scrub tooling for slowcook's tier-2 acceptance tests. Wraps a `fetch`-compatible function to intercept external-service calls, persist JSON fixtures, and serve them offline on subsequent runs.

Part of the slowcook 0.9 track. See `docs/plans/0.9-tier-2-acceptance.md` in the parent repo for the broader design.

## Install

```bash
npm install --save-dev @slowcook-ai/recorder
```

## Quickstart

```ts
import { createRecordingFetch } from "@slowcook-ai/recorder";
import { createClient } from "@supabase/supabase-js";

const recording = createRecordingFetch({
  storyId: "005",
  service: "supabase",
  // mode defaults to env: SLOWCOOK_RECORD=1 or SLOWCOOK_REPLAY=1
});

const supabase = createClient(url, key, {
  global: { fetch: recording },
});
```

Run tests with `SLOWCOOK_RECORD=1 npx playwright test` once against the real service. Fixtures land at `tests/fixtures/story-005/supabase/<hash>.json`. After that, `SLOWCOOK_REPLAY=1 npx playwright test` runs offline.

## Exports

- `createRecordingFetch(options)` — wraps `fetch` with record / replay / passthrough modes.
- `hashRequest({method, url, body?})` — stable hash used for fixture filenames. Order-insensitive for query params + body keys.
- `scrub(value, config?)` — walk a JSON value and replace UUIDs, timestamps, emails, JWTs, Supabase keys, and Bearer tokens with placeholders.
- `detectUnscrubbed(value, config?)` — returns the patterns a value still matches after scrubbing. Empty = clean. Used by `slowcook fixtures check` in CI.
- `findStaleFixtures(options?)` — returns fixtures older than `maxAgeDays` (default 14). Drives the staleness gate.

## Default scrub patterns

`uuid`, `iso-timestamp`, `email`, `jwt`, `supabase-key`, `bearer`. Disable individual defaults via `{ skip: ["uuid"] }`. Add custom regexes via `{ custom: [{ name, pattern, replacement }] }`. Keep specific strings intact via `{ allowList: [...] }`.

## License

MIT.
