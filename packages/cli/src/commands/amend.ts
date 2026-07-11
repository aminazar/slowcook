/**
 * `slowcook amend` — record a frozen-contract amendment ON THE OWNING STORY.
 *
 * (2026-07-11, from the first public LinkedIn thread.) The reason for changing
 * a frozen test must not stop at the CI summary: tests are downstream of
 * stories, so the amendment BACKPROPAGATES — an `amendments:` entry lands in
 * the story's spec yaml, in the SAME PR that changes the test. `slowcook
 * guard --override` refuses when a violated file's owning story (resolved via
 * `.brewing/manifests/story-<id>.json`) has no such entry in the diff. This
 * command writes the entry so satisfying the guard is one line:
 *
 *   slowcook amend --story 042 --reason "sort-order contract changed by #88"
 *
 * PRD-level propagation is deliberately out of scope here: specs don't
 * reference PRD sections in OSS; product-level pivots go through the spec
 * supersession flow (supersedes / superseded_by).
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import * as YAML from "yaml";

export interface AmendmentEntry {
  at: string;
  reason: string;
  pr?: string;
  files?: string[];
}

/** append an amendments entry to specs/story-<id>.yaml (creates the list). */
export function appendAmendment(repoRoot: string, storyId: string, entry: AmendmentEntry): string {
  const path = join(repoRoot, "specs", `story-${storyId}.yaml`);
  if (!existsSync(path)) throw new Error(`no spec at specs/story-${storyId}.yaml`);
  const doc = YAML.parseDocument(readFileSync(path, "utf8"));
  const existing = doc.get("amendments");
  const list = YAML.isSeq(existing) ? existing : doc.createNode([]);
  (list as YAML.YAMLSeq).add(doc.createNode(entry));
  doc.set("amendments", list);
  writeFileSync(path, doc.toString({ lineWidth: 0 }));
  return path;
}

/** resolve which story owns a test file, via the testgen manifests. */
export function owningStory(repoRoot: string, testPath: string): string | null {
  // fast path: story id embedded in the path (tests/**/story-042*.test.*)
  const m = /story-(\d+)/.exec(testPath);
  if (m) return m[1]!;
  const dir = join(repoRoot, ".brewing", "manifests");
  if (!existsSync(dir)) return null;
  try {
    const { readdirSync } = require("node:fs") as typeof import("node:fs");
    for (const f of readdirSync(dir)) {
      const mm = /^story-(\d+)\.json$/.exec(f);
      if (!mm) continue;
      try {
        const man = JSON.parse(readFileSync(join(dir, f), "utf8")) as { tests?: string[]; test_files?: string[] };
        const tests = man.tests ?? man.test_files ?? [];
        if (tests.some((t) => t === testPath || testPath.endsWith(t) || t.endsWith(testPath))) return mm[1]!;
      } catch { /* skip bad manifest */ }
    }
  } catch { /* no manifests */ }
  return null;
}

export async function amend(argv: string[]): Promise<void> {
  let story = "", reason = "", pr: string | undefined, files: string[] | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i], n = argv[i + 1];
    if (a === "--story" && n) { story = n.replace(/^story-/, ""); i++; }
    else if (a === "--reason" && n) { reason = n; i++; }
    else if (a === "--pr" && n) { pr = n; i++; }
    else if (a === "--files" && n) { files = n.split(","); i++; }
    else if (a === "--help" || a === "-h") {
      console.log(`slowcook amend — record a frozen-contract amendment on its story

Usage: slowcook amend --story <id> --reason "<why>" [--pr <#>] [--files a,b]

Appends an amendments: entry to specs/story-<id>.yaml so the reason lives
where the contract lives. Commit it in the SAME PR as the frozen-test change —
\`slowcook guard --override\` requires it.`);
      return;
    }
  }
  if (!story || !reason) { console.error("amend: --story and --reason are required (see --help)"); process.exit(64); }
  const path = appendAmendment(process.cwd(), story, { at: new Date().toISOString(), reason, ...(pr ? { pr } : {}), ...(files ? { files } : {}) });
  console.log(`✓ amendment recorded on ${path} — commit it in the same PR as the test change.`);
}
