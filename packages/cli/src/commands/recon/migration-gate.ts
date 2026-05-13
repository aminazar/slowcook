/**
 * 0.19.0-α.18 (closes #109 — migration gate in recon).
 *
 * Pre-brew structural gate. Reads the story's spec, extracts the
 * `proposals.schema.sql` block (if any), and checks that every table /
 * column the spec proposes is covered by at least one migration file
 * on disk.
 *
 * Why this gate matters: the rewo story-005 / story-006 incident class
 * — brew ships green tests against mocked DBs while the consumer's
 * `supabase/migrations/` (or `packages/postgres/src/migrations/`)
 * never gets the matching DDL. Test-time green; production-time broken.
 *
 * Pure structural check. No LLM. Sees both Supabase SQL (`*.sql`) and
 * TypeORM TS (`*.ts`) migrations via `scanMigrations`'s auto-discovery.
 *
 * Wiring: `recon` calls `checkMigrationGate` after the per-test
 * structural checks; emitted gaps share the `missing_migration` kind so
 * they roll up into the same `escalate` exit path that already exists.
 */

import {
  scanMigrations,
  extractCreateTables,
  extractColumnsAdded,
  type MigrationEntry,
} from "../refine/history-index.js";
import { readSpec } from "../refine/spec-yaml.js";

export interface MigrationGap {
  /** Source location pointer (which spec section flagged this). */
  source: string;
  /** Table the spec proposes. */
  table: string;
  /** Columns the spec proposes that are not covered by any migration. */
  missing_columns: string[];
  /** Whether the table itself is uncovered (no migration creates it at all). */
  table_missing: boolean;
}

export interface MigrationGateResult {
  /** True if the spec touches schema at all (proposals.schema.sql present + non-empty). */
  spec_proposes_schema: boolean;
  /** Total migration files scanned (across all auto-discovered dirs). */
  migrations_scanned: number;
  /** Per-table gaps. Empty array → gate is clean. */
  gaps: MigrationGap[];
  /** Diagnostic notes (e.g., "spec not found", "no schema proposal"). */
  notes: string[];
}

/**
 * Run the gate. `migrationsOverride` is for tests / explicit-dir callers;
 * normal callers pass undefined and let the scanner auto-discover.
 *
 * Returns a structured result even when there are no gaps so callers can
 * log how much was scanned. `gaps.length === 0` is the clean signal.
 */
export function checkMigrationGate(
  repoRoot: string,
  storyId: string,
  migrationsOverride?: MigrationEntry[]
): MigrationGateResult {
  const result: MigrationGateResult = {
    spec_proposes_schema: false,
    migrations_scanned: 0,
    gaps: [],
    notes: [],
  };

  // 1. Try to read the spec. Specs may not exist for non-slowcook-driven
  //    stories (e.g., manual bug fixes). In that case the gate is a no-op:
  //    we have no PM-authored schema contract to check against.
  let proposalSql = "";
  try {
    const spec = readSpec(repoRoot, storyId);
    proposalSql = spec.proposals?.schema?.sql ?? "";
  } catch (e) {
    result.notes.push(
      `Spec not found or invalid for story-${storyId}: ${(e as Error).message.slice(0, 200)}`
    );
    return result;
  }

  if (!proposalSql.trim()) {
    result.notes.push(
      `Spec story-${storyId} has no proposals.schema.sql block — migration gate is a no-op for this story.`
    );
    return result;
  }
  result.spec_proposes_schema = true;

  // 2. Parse the proposal SQL for tables + columns.
  const proposedTables = extractCreateTables(proposalSql);
  const proposedColumns = extractColumnsAdded(proposalSql);

  // 3. Load migration coverage. The scanner auto-discovers Supabase vs
  //    TypeORM dirs; pass the conventional default and let it fall back.
  const migrations =
    migrationsOverride ?? scanMigrations(repoRoot, "supabase/migrations");
  result.migrations_scanned = migrations.length;

  // 4. Build coverage indices.
  const coveredTables = new Set(migrations.flatMap((m) => m.tables_created));
  const coveredColumnsByTable: Record<string, Set<string>> = {};
  for (const m of migrations) {
    for (const [t, cols] of Object.entries(m.columns_added)) {
      if (!coveredColumnsByTable[t]) {
        coveredColumnsByTable[t] = new Set();
      }
      for (const c of cols) coveredColumnsByTable[t]!.add(c);
    }
  }

  // 5. Walk proposed tables. Two-tier check:
  //    (a) Is the table itself present in some migration? If not → gap with
  //        table_missing=true and the FULL list of proposed columns flagged.
  //    (b) If the table exists, are all proposed columns covered? Missing
  //        columns produce a gap with table_missing=false.
  //
  //    Tables that appear in proposedColumns but NOT in proposedTables (e.g.,
  //    a pure ALTER TABLE proposal) are also walked — that path is the
  //    "spec proposes new columns on an existing brownfield table" case,
  //    which is exactly the rewo story-005 incident shape.
  const allProposedTables = new Set([
    ...proposedTables,
    ...Object.keys(proposedColumns),
  ]);

  for (const t of allProposedTables) {
    const proposedCols = proposedColumns[t] ?? [];
    if (!coveredTables.has(t)) {
      // Table missing entirely. If the spec ONLY proposes ALTERs (not a CREATE)
      // and the table is brownfield-only, it shows up here too — that's the
      // ALTER-on-uncreated-table case (rare but worth flagging the same way).
      result.gaps.push({
        source: `specs/story-${storyId}.yaml#proposals.schema.sql`,
        table: t,
        missing_columns: proposedCols,
        table_missing: true,
      });
      continue;
    }
    const coveredCols = coveredColumnsByTable[t] ?? new Set();
    const missing = proposedCols.filter((c) => !coveredCols.has(c));
    if (missing.length > 0) {
      result.gaps.push({
        source: `specs/story-${storyId}.yaml#proposals.schema.sql`,
        table: t,
        missing_columns: missing,
        table_missing: false,
      });
    }
  }

  return result;
}

/**
 * Render a single migration gap into recon's `detail` + `recommendation`
 * shape. Pulled out as its own helper so the recon entry point and tests
 * can both consume it.
 */
export function formatMigrationGap(g: MigrationGap): {
  detail: string;
  recommendation: string;
} {
  if (g.table_missing) {
    return {
      detail: `Spec proposes table "${g.table}" (cols: ${g.missing_columns.join(", ") || "—"}) but no migration creates it.`,
      recommendation: `Author a migration that creates the table BEFORE dispatching brew. For TypeORM consumers: \`packages/postgres/src/migrations/<ts>-create-${g.table}.ts\` with a \`DatabaseCreateTable\` or raw \`CREATE TABLE\`. For Supabase: \`supabase/migrations/<ts>_create_${g.table}.sql\`.`,
    };
  }
  return {
    detail: `Spec proposes columns ${g.missing_columns.map((c) => `"${c}"`).join(", ")} on table "${g.table}" but no migration adds them.`,
    recommendation: `Add an \`ALTER TABLE ${g.table} ADD COLUMN <col> <type>\` migration covering: ${g.missing_columns.join(", ")}. Land it BEFORE dispatching brew.`,
  };
}
