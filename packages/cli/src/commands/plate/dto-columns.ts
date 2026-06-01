/**
 * `validatePlateDtoColumns` — 0.19.5-α (sc#151 #4).
 *
 * Pure helper that flags every DTO field which has NO backing column
 * in the consumer's TypeORM migrations AND no explicit
 * `// computed: <source>` comment justifying its existence.
 *
 * Concrete recurrence (delgoosh story-006): the spec declared
 * `lastMessagePreview` on `PeerChatThreadListItemDto` but no
 * `last_message_body` column was added to `peer_chat_threads`. Brew
 * was forced into a join-the-latest-message-per-row query OR returning
 * null. Plate is the right point to surface this — the data layer
 * (DTOs + migrations) is what plate reconciles when amending the
 * mockup, so column-vs-DTO drift is in plate's wheelhouse.
 *
 * Action is "flagged" — the resolution is upstream: drop the field
 * from the DTO OR add the backing column to the migration OR add a
 * `// computed: <source>` comment explaining the JOIN/aggregate.
 *
 * Designed pure (no fs / no LLM): caller passes file contents already
 * read. Same shape as `validateRouteCollisions` (sc#152) and
 * `validateEntityFieldReferences` (sc#132).
 */

import type { SpecValidationFinding } from "../refine/spec-validate.js";

export interface PlateDtoFinding extends SpecValidationFinding {
  /** The DTO field name (camelCase, as it appears in TypeScript). */
  fieldName: string;
  /** Repo-relative path to the DTO file that declares the field. */
  dtoFile: string;
  /** Line number of the field declaration in the DTO file (1-based). */
  dtoLine: number;
}

export interface DtoFile {
  /** Repo-relative path, e.g. `packages/dtos/src/back/peer-chat/list-threads.response.dto.ts`. */
  path: string;
  /** Full file contents (UTF-8). */
  contents: string;
}

export interface MigrationFile {
  /** Repo-relative path, e.g. `packages/postgres/src/migrations/1772100000000-create-peer-chat-tables.ts`. */
  path: string;
  /** Full file contents (UTF-8). */
  contents: string;
}

/**
 * Run the check.
 *
 * @param dtos - all DTO files (typically the union of
 *               `packages/dtos/src/**\/*.ts` AND the consumer's
 *               `apps/<app>/src/modules/<feature>/dtos/*.ts`).
 * @param migrations - all migration files
 *                     (`packages/postgres/src/migrations/*.ts` etc.).
 */
export function validatePlateDtoColumns(
  dtos: DtoFile[],
  migrations: MigrationFile[]
): PlateDtoFinding[] {
  const findings: PlateDtoFinding[] = [];

  // Build the set of all known column names from migration files.
  // Migration files use the TypeORM addColumn / DatabaseCreateTable
  // patterns; both lay column names as `name: '<snake_case>'`. We
  // collect those literals + also store the camelCase equivalent so
  // DTOs can match by either form.
  const knownColumns = new Set<string>();
  // Match `name: 'snake_case'` and `name: "snake_case"` — be liberal
  // with whitespace + single/double quotes.
  const colRe = /\bname\s*:\s*['"]([a-z][a-z0-9_]*)['"]/g;
  for (const m of migrations) {
    let match: RegExpExecArray | null;
    while ((match = colRe.exec(m.contents)) !== null) {
      const snake = match[1]!;
      knownColumns.add(snake);
      knownColumns.add(snakeToCamel(snake));
    }
    colRe.lastIndex = 0;
  }

  // Always-allowed identifiers: primary-key + audit columns from
  // BaseEntity-style scaffolds. These rarely appear in migrations
  // because they're provided by the BaseEntity helper.
  const allowed = new Set<string>([
    "id",
    "createdAt",
    "updatedAt",
    "deletedAt",
    "created_at",
    "updated_at",
    "deleted_at",
  ]);

  for (const dto of dtos) {
    const lines = dto.contents.split(/\r?\n/);
    // Track the last comment we saw so we can pair it with the field
    // beneath it (TypeScript convention: `// computed: ...` above the
    // field declaration).
    let lastCommentMarker: { lineNo: number; text: string } | null = null;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      const trimmed = line.trim();
      // Detect a `// computed: ...` marker (or `// @computed`).
      // Marker stays valid for one declaration; reset after consuming.
      if (
        /^\/\/\s*(?:computed|@computed)\b/i.test(trimmed) ||
        /^\/\*\s*(?:computed|@computed)\b/i.test(trimmed)
      ) {
        lastCommentMarker = { lineNo: i + 1, text: trimmed };
        continue;
      }
      // Skip blank lines + non-field lines but keep the marker valid
      // through one blank line so `// computed: …\n\nfield: ...` works.
      if (trimmed === "") continue;
      // Skip jsdoc / generic comments — they don't qualify as
      // computed-source markers and shouldn't shadow a real one.
      if (
        trimmed.startsWith("//") ||
        trimmed.startsWith("/*") ||
        trimmed.startsWith("*") ||
        trimmed.startsWith("*/")
      ) {
        continue;
      }
      // Match a TypeScript field declaration. Conservative regex —
      // we want false negatives over false positives. Matches:
      //   foo: string;
      //   public foo: string;
      //   readonly foo?: string;
      //   foo: string = "default";
      const fieldMatch = trimmed.match(
        /^(?:public\s+|private\s+|protected\s+|readonly\s+)*([a-z][a-zA-Z0-9_]*)\??\s*:/
      );
      if (!fieldMatch) continue;
      const fieldName = fieldMatch[1]!;
      // Skip framework / scaffolding fields.
      if (allowed.has(fieldName)) {
        lastCommentMarker = null;
        continue;
      }
      // If we saw a computed marker for this field, accept + reset.
      if (lastCommentMarker) {
        lastCommentMarker = null;
        continue;
      }
      // If field name matches a known column, accept.
      if (knownColumns.has(fieldName)) {
        continue;
      }
      findings.push({
        path: `${dto.path}:${i + 1}`,
        message:
          `DTO field \`${fieldName}\` has no matching column in any migration + no ` +
          `\`// computed: <source>\` comment. Either add the column to a migration, ` +
          `drop the field from the DTO, or annotate the field with ` +
          `\`// computed: <source>\` explaining the JOIN/aggregate that backs it.`,
        action: "flagged",
        fieldName,
        dtoFile: dto.path,
        dtoLine: i + 1,
      });
    }
  }

  return findings;
}

function snakeToCamel(s: string): string {
  return s.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
}
