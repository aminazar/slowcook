// `slowcook analyze` — cross-spec + as-built consistency gate (S3, #528;
// docs/plans/spec-kit-borrowings.md). Adapts the analyze idea from
// GitHub's Spec Kit (github/spec-kit, MIT) into deterministic-first
// checks; the semantic pass is taste's job, fed by these findings.
//
// The two failure classes it exists for (rewo season, 2026-08):
//   - story-016 `rewoSlug` vs story-017 `rewo_id`: two MERGED specs
//     declared the same endpoint with contradictory request fields;
//     brew built against the wrong one ($5.18) before anyone noticed.
//   - story-019's spec referenced a `member_rewos` table that existed
//     nowhere — not in migrations, not created by any active spec.
//
//   slowcook analyze --spec <id> [--cwd <path>] [--json]
//
// Exit codes: 0 clean · 1 findings · 2 setup error.

import { join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import YAML from "yaml";
import type { Spec } from "@slowcook-ai/core";
import { listActiveSpecs } from "../refine/spec-yaml.js";
import { buildHistoryIndex } from "../refine/history-index.js";

export interface AnalyzeFinding {
  kind:
    | "request-field-conflict"
    | "response-conflict"
    | "table-create-collision"
    | "unknown-entity";
  message: string;
  /** Both sides, so a reviewer can rule without re-deriving. */
  cites: string[];
}

/** `:slug`, `{slug}`, `[slug]` segments all normalize to `:param` so the
 *  same endpoint spelled with different param names still collides. */
export function normalizePath(p: string): string {
  return p
    .trim()
    .replace(/\/+$/, "")
    .split("/")
    .map((seg) =>
      /^(:|\{|\[)/.test(seg) || /^<.+>$/.test(seg) ? ":param" : seg.toLowerCase()
    )
    .join("/");
}

function schemaKeys(schema: unknown): string[] | null {
  if (schema && typeof schema === "object" && !Array.isArray(schema)) {
    return Object.keys(schema as Record<string, unknown>).sort();
  }
  return null; // free-form / string schemas: no deterministic comparison
}

/** Tables a spec's DDL creates / alters. */
export function ddlTables(sql: string): { created: string[]; altered: string[] } {
  const created: string[] = [];
  const altered: string[] = [];
  const createRe = /create\s+table(?:\s+if\s+not\s+exists)?\s+"?([\w.]+)"?/gi;
  const alterRe = /alter\s+table(?:\s+only)?\s+"?([\w.]+)"?/gi;
  let m: RegExpExecArray | null;
  while ((m = createRe.exec(sql))) created.push(stripSchema(m[1]!));
  while ((m = alterRe.exec(sql))) altered.push(stripSchema(m[1]!));
  return { created, altered };
}

function stripSchema(table: string): string {
  return table.includes(".") ? table.split(".").pop()! : table;
}

function specDdl(spec: Spec): string {
  return spec.proposals?.schema?.sql ?? "";
}

function specCreatedTables(spec: Spec): string[] {
  return ddlTables(specDdl(spec)).created;
}

export function analyzeSpec(
  target: Spec,
  others: Spec[],
  asBuiltTables: Set<string>
): AnalyzeFinding[] {
  const findings: AnalyzeFinding[] = [];
  const my = `story-${target.story_id}`;

  // 1) Endpoint contract conflicts against every other active spec.
  for (const mine of target.api_contract ?? []) {
    const myPath = normalizePath(mine.path);
    for (const other of others) {
      if (other.story_id === target.story_id) continue;
      for (const theirs of other.api_contract ?? []) {
        if (
          theirs.method.toUpperCase() !== mine.method.toUpperCase() ||
          normalizePath(theirs.path) !== myPath
        ) {
          continue;
        }
        const mineKeys = schemaKeys(mine.request_schema);
        const theirKeys = schemaKeys(theirs.request_schema);
        if (mineKeys && theirKeys && mineKeys.join(",") !== theirKeys.join(",")) {
          findings.push({
            kind: "request-field-conflict",
            message:
              `${mine.method.toUpperCase()} ${mine.path}: request fields {${mineKeys.join(", ")}} ` +
              `contradict story-${other.story_id}'s {${theirKeys.join(", ")}} for the same endpoint. ` +
              `One contract per endpoint — the shipped/owning spec wins; align or supersede.`,
            cites: [`${my} api_contract ${mine.path}`, `story-${other.story_id} api_contract ${theirs.path}`],
          });
        }
        const mineResp = mine.responses ? Object.keys(mine.responses).sort().join(",") : null;
        const theirResp = theirs.responses ? Object.keys(theirs.responses).sort().join(",") : null;
        if (mineResp && theirResp && mineResp !== theirResp) {
          findings.push({
            kind: "response-conflict",
            message:
              `${mine.method.toUpperCase()} ${mine.path}: response statuses [${mineResp}] differ from ` +
              `story-${other.story_id}'s [${theirResp}] for the same endpoint.`,
            cites: [`${my} api_contract ${mine.path}`, `story-${other.story_id} api_contract ${theirs.path}`],
          });
        }
      }
    }
  }

  // 2) Same-table CREATE across two active specs.
  const myCreates = specCreatedTables(target);
  for (const other of others) {
    if (other.story_id === target.story_id) continue;
    const overlap = specCreatedTables(other).filter((t) => myCreates.includes(t));
    for (const t of overlap) {
      findings.push({
        kind: "table-create-collision",
        message:
          `both ${my} and story-${other.story_id} CREATE TABLE ${t} — one owner per table; ` +
          `the second spec must reference, extend, or supersede.`,
        cites: [`${my} proposals.schema`, `story-${other.story_id} proposals.schema`],
      });
    }
  }

  // 3) Cited entities/tables must exist somewhere real: as-built
  //    migrations, this spec's own DDL, or another ACTIVE spec's DDL
  //    (pipeline-pending). The member_rewos class.
  const known = new Set<string>(asBuiltTables);
  for (const t of myCreates) known.add(t);
  for (const other of others) for (const t of specCreatedTables(other)) known.add(t);

  for (const e of target.data_contract?.entities ?? []) {
    if (!known.has(e.name)) {
      findings.push({
        kind: "unknown-entity",
        message:
          `data_contract entity "${e.name}" exists nowhere: not in migrations, not created by ` +
          `this spec's DDL, not created by any active spec. Declare it (proposals.schema) or fix the name.`,
        cites: [`${my} data_contract.entities`],
      });
    }
  }
  for (const t of ddlTables(specDdl(target)).altered) {
    if (!known.has(t)) {
      findings.push({
        kind: "unknown-entity",
        message:
          `DDL alters table "${t}" which exists nowhere (not in migrations, not created by any active spec).`,
        cites: [`${my} proposals.schema`],
      });
    }
  }

  return findings;
}

/** Analyze a spec given as YAML text (taste's spec-PR path — the spec
 *  is PR content, not necessarily on disk). */
export async function analyzeSpecYaml(
  specYaml: string,
  repoRoot: string
): Promise<AnalyzeFinding[]> {
  const target = YAML.parse(specYaml) as Spec;
  if (!target || !target.story_id) return [];
  const others = listActiveSpecs(repoRoot).filter((s) => s.story_id !== target.story_id);
  const index = buildHistoryIndex({ repoRoot });
  const asBuilt = new Set<string>();
  for (const mig of index.migrations) {
    for (const t of mig.tables_created) asBuilt.add(t);
    for (const t of Object.keys(mig.columns_added)) asBuilt.add(t);
  }
  return analyzeSpec(target, others, asBuilt);
}

export function renderFindings(findings: AnalyzeFinding[]): string {
  if (findings.length === 0) return "analyze: clean — no cross-spec or as-built conflicts.";
  const lines = [`analyze: ${findings.length} finding(s):`];
  for (const f of findings) {
    lines.push(`  ✗ [${f.kind}] ${f.message}`);
    for (const c of f.cites) lines.push(`      ↳ ${c}`);
  }
  return lines.join("\n");
}

export async function analyze(argv: string[]): Promise<void> {
  let cwd = process.cwd();
  let specId: string | undefined;
  let json = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const next = argv[i + 1];
    if ((a === "--spec" || a === "--story") && next) { specId = next.replace(/^story-/, ""); i++; }
    else if (a === "--cwd" && next) { cwd = next; i++; }
    else if (a === "--json") { json = true; }
    else if (a === "--help" || a === "-h") { printHelp(); return; }
  }
  if (!specId) {
    console.error("usage: slowcook analyze --spec <id> [--cwd <path>] [--json]");
    process.exitCode = 64;
    return;
  }
  const specPath = join(cwd, "specs", `story-${specId}.yaml`);
  if (!existsSync(specPath)) {
    console.error(`spec not found: ${specPath}`);
    process.exitCode = 2;
    return;
  }
  const findings = await analyzeSpecYaml(readFileSync(specPath, "utf8"), cwd);
  if (json) {
    console.log(JSON.stringify({ spec: specId, findings }, null, 2));
  } else {
    console.log(renderFindings(findings));
  }
  if (findings.length > 0) process.exitCode = 1;
}

function printHelp(): void {
  console.log(`
slowcook analyze — cross-spec + as-built consistency for one spec

Deterministic checks (the semantic pass is taste's job, fed by these):
  - same endpoint declared with contradictory request fields / responses
    in another ACTIVE spec (param names normalize: /r/:slug ≡ /r/:id)
  - two active specs both CREATE the same table
  - cited entities / altered tables that exist nowhere (not in
    migrations, not created by any active spec)

Usage:
  slowcook analyze --spec <id> [--cwd <path>] [--json]

Exit codes: 0 clean · 1 findings · 2 setup error.
Adapted from Spec Kit (github/spec-kit, MIT) — docs/plans/spec-kit-borrowings.md.
`);
}
