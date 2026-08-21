// Manifest types and pure diff logic. No I/O — the CLI owns reading/writing.
// Purpose: a recorded manifest captures the set of tests discoverable at a
// freeze point. Verify compares a current discovery against it and flags any
// recorded tests that are no longer discoverable (file deleted, renamed,
// syntactically broken, or excluded from discovery).

export interface TestEntry {
  /** Stable identifier. By convention "<file> > <describe-chain> > <test-name>". */
  id: string;
  /** File containing the test (relative to repo root). */
  file: string;
}

export interface Manifest {
  /** Manifest schema version. Bump when the shape changes incompatibly. */
  schema_version: 1;
  /** slowcook CLI version that recorded this manifest. Diagnostic only. */
  slowcook_version: string;
  /** ISO-8601 UTC timestamp of recording. */
  recorded_at: string;
  /** Optional story id if this manifest is story-scoped. Null for "all tests". */
  story_id: string | null;
  /** The recorded test entries. */
  tests: TestEntry[];
  /** Per-suite metadata about how discovery was performed. */
  suites: SuiteRecord[];
  /** sha256 of the spec these tests were generated against (eleven-defects
   * D10). Absent on pre-drift manifests — consumers treat absence as
   * "unknown", never as drift. */
  spec_sha256?: string;
}

export interface SuiteRecord {
  /** Suite name from stack.json (e.g., "backend", "e2e"). */
  suite: string;
  /** Command used for discovery. */
  command: string;
  /** Count of tests discovered in this suite. */
  test_count: number;
}

export interface ManifestDiff {
  /** Tests recorded in the manifest that are no longer discoverable. */
  missing: TestEntry[];
  /** Tests currently discoverable but not in the manifest. Informational only; not a violation. */
  added: TestEntry[];
  /** Tests present in both. */
  retained: TestEntry[];
}

/**
 * Compare a recorded manifest against a fresh discovery. The caller decides
 * what to do with the result; in the default brewing pipeline, any `missing`
 * entries are a violation (exit 1) and `added` entries are informational.
 */
export function diffManifest(
  recorded: Manifest,
  currentTests: TestEntry[]
): ManifestDiff {
  const currentById = new Map(currentTests.map((t) => [t.id, t]));
  const recordedById = new Map(recorded.tests.map((t) => [t.id, t]));

  const missing: TestEntry[] = [];
  const retained: TestEntry[] = [];
  for (const t of recorded.tests) {
    if (currentById.has(t.id)) retained.push(t);
    else missing.push(t);
  }

  const added: TestEntry[] = [];
  for (const t of currentTests) {
    if (!recordedById.has(t.id)) added.push(t);
  }

  return { missing, added, retained };
}

/**
 * Build a manifest from a fresh discovery result.
 */
export function buildManifest(args: {
  slowcookVersion: string;
  storyId: string | null;
  tests: TestEntry[];
  suites: SuiteRecord[];
  now?: Date;
  /** sha256 of the source spec (D10 drift detection). */
  specSha256?: string;
}): Manifest {
  return {
    schema_version: 1,
    slowcook_version: args.slowcookVersion,
    recorded_at: (args.now ?? new Date()).toISOString(),
    story_id: args.storyId,
    tests: args.tests,
    suites: args.suites,
    ...(args.specSha256 !== undefined ? { spec_sha256: args.specSha256 } : {}),
  };
}
