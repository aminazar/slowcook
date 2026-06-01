import type { Spec } from "@slowcook-ai/core";

/**
 * 0.14.0-α.6+ — content-level validators for parsed specs. Runs AFTER
 * Zod shape-validation, BEFORE writing to disk. Catches LLM-output
 * truncation that shape-validation misses (e.g. `var(--tint-in` is a
 * valid string but a corrupted token).
 *
 * Detects + repairs in place when the fix is unambiguous; drops + logs
 * otherwise. Returns a list of human-readable findings so the caller
 * can surface them in the PR body or run logs.
 *
 * Caught on rewo story-016 (2026-04-26): LLM emit ended a 12-token list
 * mid-entry with `var(--tint-in`. Spec passed Zod, the corrupt token
 * sat in tokens_to_reuse and downstream brew/testgen would see it as
 * a real (but missing) project token.
 */

export interface SpecValidationFinding {
  /** Dotted path to the field, e.g. "proposals.ui_layout.tokens_to_reuse[12]". */
  path: string;
  /** What we noticed. */
  message: string;
  /** Action taken: "dropped" (entry removed), "repaired" (auto-fixed), "flagged" (kept as-is, needs-review). */
  action: "dropped" | "repaired" | "flagged";
}

/** Mutates `spec` in place; returns findings for caller to surface. */
export function validateAndRepairSpec(spec: Spec): SpecValidationFinding[] {
  const findings: SpecValidationFinding[] = [];

  const ui = spec.proposals?.ui_layout;
  if (ui) {
    if (ui.tokens_to_reuse) {
      ui.tokens_to_reuse = pruneTokenList(
        ui.tokens_to_reuse,
        "proposals.ui_layout.tokens_to_reuse",
        findings
      );
    }
    if (ui.tokens_to_add) {
      ui.tokens_to_add = pruneTokenList(
        ui.tokens_to_add,
        "proposals.ui_layout.tokens_to_add",
        findings
      );
    }
    if (ui.components_to_reuse) {
      ui.components_to_reuse = pruneStringList(
        ui.components_to_reuse,
        "proposals.ui_layout.components_to_reuse",
        findings
      );
    }
  }

  return findings;
}

/**
 * Token entries are usually one of:
 *   - Tailwind class:  bg-coral, text-foreground/60, divide-card-border
 *   - CSS var ref:     var(--coral)
 *   - Bare token name: --tint-celebrate
 *
 * Truncation symptoms:
 *   - `var(--tint-in` — open paren, no close
 *   - `var(--coral`   — same
 *   - `bg-` (alone)   — class prefix with no value
 *   - empty string
 */
function pruneTokenList(
  items: string[],
  pathPrefix: string,
  findings: SpecValidationFinding[]
): string[] {
  const out: string[] = [];
  for (let i = 0; i < items.length; i++) {
    const raw = items[i];
    if (typeof raw !== "string" || raw.trim().length === 0) {
      findings.push({
        path: `${pathPrefix}[${i}]`,
        message: `Empty or non-string token entry (was: ${JSON.stringify(raw)})`,
        action: "dropped",
      });
      continue;
    }
    const t = raw.trim();
    // Unterminated var()
    if (/^var\([^)]*$/.test(t)) {
      findings.push({
        path: `${pathPrefix}[${i}]`,
        message: `Unterminated var() — likely LLM-emit truncation: ${JSON.stringify(t)}`,
        action: "dropped",
      });
      continue;
    }
    // Class-prefix-only (`bg-`, `text-`, `border-`)
    if (/^(?:bg|text|border|divide|ring|fill|stroke|font)-?$/.test(t)) {
      findings.push({
        path: `${pathPrefix}[${i}]`,
        message: `Class-prefix-only token (no value): ${JSON.stringify(t)}`,
        action: "dropped",
      });
      continue;
    }
    out.push(t);
  }
  return out;
}

/**
 * 0.19.x+ — catch hallucinated entity.field references in the spec.
 *
 * Refine sometimes invents fields that don't exist on the consumer's
 * actual entities (e.g. story-005 in delgoosh referenced
 * `user.timezone.label` but Timezone has only `name`/`offset`/`offsetStr`).
 * Brew + testgen downstream silently grounded against the wrong field,
 * leading to a runtime error that took a human to spot.
 *
 * This lint parses `.brewing/repo-knowledge/auto/backend-entities.md`,
 * walks every string-typed field of the spec, and for each
 * `lowercaseName.fieldName` pair where `lowercaseName` matches a known
 * entity, checks whether `fieldName` is in that entity's field set.
 * Misses are flagged as `"flagged"` (kept as-is — the spec text isn't
 * auto-repairable since we don't know what the author meant).
 *
 * Chained references like `user.timezone.label` are decomposed into
 * pairs (`user.timezone`, `timezone.label`); each pair is checked
 * independently. Relation traversal works because relation field
 * values are themselves listed in the entity catalog with the
 * other-entity name as their type.
 *
 * Exported for testing.
 */
export function parseEntityCatalog(md: string): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  let current: string | null = null;
  let currentFields: Set<string> | null = null;
  for (const line of md.split(/\r?\n/)) {
    const headerMatch = line.match(/^##\s+([A-Z]\w+)\b/);
    if (headerMatch) {
      if (current && currentFields) out.set(current, currentFields);
      // Map by LOWERCASED entity name so spec text like `user.firstName`
      // resolves to the User entity.
      current = headerMatch[1]!.toLowerCase();
      currentFields = new Set<string>();
      continue;
    }
    if (!currentFields) continue;
    const fieldMatch = line.match(/^-\s+(\w+)\??:/);
    if (fieldMatch) currentFields.add(fieldMatch[1]!);
  }
  if (current && currentFields) out.set(current, currentFields);
  return out;
}

/**
 * Walk every string in a value (recursing into arrays/objects).
 * Yields each string with a dotted path for diagnostic context.
 */
function* walkStrings(
  value: unknown,
  path = ""
): Generator<{ path: string; text: string }> {
  if (typeof value === "string") {
    yield { path, text: value };
    return;
  }
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      yield* walkStrings(value[i], `${path}[${i}]`);
    }
    return;
  }
  if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      yield* walkStrings(v, path ? `${path}.${k}` : k);
    }
  }
}

export function validateEntityFieldReferences(
  spec: Spec,
  entityCatalogMd: string
): SpecValidationFinding[] {
  const findings: SpecValidationFinding[] = [];
  const catalog = parseEntityCatalog(entityCatalogMd);
  if (catalog.size === 0) return findings; // No catalog → can't lint.

  // Sections worth walking. We deliberately skip free-form metadata
  // (title, notes, rationale text under proposals) to keep false-
  // positives low — only fields where field references are LOAD-BEARING.
  const sections: Array<{ key: keyof Spec; value: unknown }> = [
    { key: "invariants", value: spec.invariants },
    { key: "preconditions", value: spec.preconditions },
    { key: "acceptance_scenarios", value: spec.acceptance_scenarios },
    { key: "api_contract", value: spec.api_contract },
    { key: "ui_behavior", value: spec.ui_behavior },
  ];

  // Per pair, only flag the FIRST occurrence so a single typo
  // doesn't generate noise across 20 invariants.
  const seen = new Set<string>();

  for (const section of sections) {
    if (section.value == null) continue;
    for (const { path, text } of walkStrings(section.value, String(section.key))) {
      // Match every dotted chain (>=2 segments) and split into adjacent
      // pairs. `regex.exec` with /g advances past each full match, so we
      // can't catch overlapping pairs (`user.timezone` and
      // `timezone.label` inside `user.timezone.label`) with a single
      // pair-regex — extract the whole chain and decompose.
      const chainRe = /\b([a-z][a-zA-Z0-9_]*(?:\.[a-zA-Z][a-zA-Z0-9_]*)+)\b/g;
      let m: RegExpExecArray | null;
      while ((m = chainRe.exec(text)) !== null) {
        const segments = m[1]!.split(".");
        for (let i = 0; i < segments.length - 1; i++) {
          const lhs = segments[i]!.toLowerCase();
          const rhs = segments[i + 1]!;
          const fields = catalog.get(lhs);
          if (!fields) continue; // LHS isn't a known entity — skip.
          if (fields.has(rhs)) continue; // Field exists.
          const key = `${lhs}.${rhs}`;
          if (seen.has(key)) continue;
          seen.add(key);
          findings.push({
            path,
            message: `Spec references \`${segments[i]}.${rhs}\` but the ${lhs} entity has no \`${rhs}\` field. Known fields: ${[...fields].sort().join(", ") || "(none)"}.`,
            action: "flagged",
          });
        }
      }
    }
  }

  return findings;
}

/**
 * 0.19.x+ — check whether the mock files refine listed in
 * `components_to_reuse` actually render the spec's data fields.
 *
 * Refine derives `components_to_reuse` from spec prose mentions of
 * `src/components/...` paths (proposals-synth.ts:198). It doesn't
 * verify the mock at that path actually mentions the fields the
 * spec cares about. A reuse listing of the WRONG mock misleads
 * brew into lifting unrelated UI.
 *
 * Concrete repro (delgoosh story-005):
 *   spec.invariants reference user.firstName / user.lastName /
 *   user.email / userLocation.city / userLocation.country / etc.
 *   refine's components_to_reuse listed mock/src/app/patient/profile/page.tsx
 *   which actually renders therapy PREFERENCES (topics/approach/gender/belief)
 *   — none of the spec's fields appear in that mock at all.
 *
 * Heuristic: extract the set of unique field names mentioned in the
 * spec's load-bearing sections (RHS of every dotted reference like
 * `user.firstName`). For each `components_to_reuse` entry that names
 * a real path, count how many of those field names appear in the
 * file body. If overlap is < 25% of the spec's field set AND the
 * file body is non-trivial (>500 chars — empty mocks aren't false
 * positives), flag the entry.
 *
 * Action is "flagged" — the spec text isn't auto-repairable; the
 * author needs to either drop the reuse listing or rebuild the
 * mock at that path. Surfaced in run logs alongside other findings.
 *
 * Exported for testing.
 */
export function validateComponentReuseShape(
  spec: Spec,
  mockReader: (path: string) => string | null
): SpecValidationFinding[] {
  const findings: SpecValidationFinding[] = [];
  const reuse = spec.proposals?.ui_layout?.components_to_reuse;
  if (!reuse || reuse.length === 0) return findings;

  // Extract every field-name (RHS-and-after of dotted refs) from
  // load-bearing sections — same chain shape as
  // validateEntityFieldReferences.
  const sections: unknown[] = [
    spec.invariants,
    spec.preconditions,
    spec.acceptance_scenarios,
    spec.api_contract,
    spec.ui_behavior,
  ];
  const specFields = new Set<string>();
  const chainRe = /\b[a-z][a-zA-Z0-9_]*(?:\.[a-zA-Z][a-zA-Z0-9_]*)+\b/g;
  for (const section of sections) {
    if (section == null) continue;
    for (const { text } of walkStrings(section)) {
      let m: RegExpExecArray | null;
      while ((m = chainRe.exec(text)) !== null) {
        const segments = m[0].split(".");
        for (let i = 1; i < segments.length; i++) {
          specFields.add(segments[i]!);
        }
      }
    }
  }
  if (specFields.size === 0) return findings;

  for (let i = 0; i < reuse.length; i++) {
    const entry = reuse[i]!;
    // Skip backtick-name entries (`Component-name (path TBD)`) — no path to read.
    const pathMatch = entry.match(/^(src\/[^\s(]+|mock\/[^\s(]+|apps\/[^\s(]+)/);
    if (!pathMatch) continue;
    const body = mockReader(pathMatch[1]!);
    if (body == null) {
      findings.push({
        path: `proposals.ui_layout.components_to_reuse[${i}]`,
        message: `Reuse target ${JSON.stringify(pathMatch[1])} does not exist on disk — path is wrong, or the mock hasn't been authored yet.`,
        action: "flagged",
      });
      continue;
    }
    if (body.length < 500) continue; // Empty / placeholder mock — not a false positive.
    let hits = 0;
    for (const f of specFields) {
      const re = new RegExp(`\\b${f.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`);
      if (re.test(body)) hits++;
    }
    const ratio = hits / specFields.size;
    if (ratio < 0.25) {
      findings.push({
        path: `proposals.ui_layout.components_to_reuse[${i}]`,
        message: `Reuse target ${JSON.stringify(pathMatch[1])} mentions only ${hits}/${specFields.size} of the spec's data fields (${Math.round(ratio * 100)}%). The mock likely renders a different surface — verify the listing or update the mock before brew lifts it.`,
        action: "flagged",
      });
    }
  }
  return findings;
}

function pruneStringList(
  items: string[],
  pathPrefix: string,
  findings: SpecValidationFinding[]
): string[] {
  const out: string[] = [];
  for (let i = 0; i < items.length; i++) {
    const raw = items[i];
    if (typeof raw !== "string" || raw.trim().length === 0) {
      findings.push({
        path: `${pathPrefix}[${i}]`,
        message: `Empty or non-string entry (was: ${JSON.stringify(raw)})`,
        action: "dropped",
      });
      continue;
    }
    const t = raw.trim();
    // Truncated path or component name (ends mid-identifier)
    if (/[/.][a-z0-9_-]*$/i.test(t) === false && t.endsWith("-")) {
      findings.push({
        path: `${pathPrefix}[${i}]`,
        message: `String ends mid-identifier (truncation symptom): ${JSON.stringify(t)}`,
        action: "dropped",
      });
      continue;
    }
    out.push(t);
  }
  return out;
}

/**
 * 0.19.4-α+ (sc#151 finding 3) — flag every `routes.paths[].file` whose
 * destination path is ALREADY OCCUPIED by an existing file in the consumer
 * repo. Refine sometimes proposes a route at e.g. `/patient/chat` because
 * the spec uses it as the natural noun, but the consumer repo already
 * hosts a different feature at that path (AI chat vs peer chat in the
 * delgoosh dogfood). Brew would have to either silently overwrite the
 * live page or pick a different path on its own — neither is a clean
 * handoff.
 *
 * Action is "flagged" (not "repaired") — the resolution is upstream:
 * the spec author renames the route OR the existing file relocates
 * before the spec merges.
 *
 * `fileExists` is a reader so the function stays pure + testable.
 * Callers pass `(p) => existsSync(join(repoRoot, p))`.
 */
export function validateRouteCollisions(
  spec: Spec,
  fileExists: (path: string) => boolean
): SpecValidationFinding[] {
  const findings: SpecValidationFinding[] = [];
  const paths = spec.proposals?.routes?.paths;
  if (!paths || paths.length === 0) return findings;
  for (let i = 0; i < paths.length; i++) {
    const entry = paths[i];
    if (!entry) continue;
    const file = entry.file;
    if (typeof file !== "string" || file.length === 0) continue;
    if (fileExists(file)) {
      findings.push({
        path: `proposals.routes.paths[${i}].file`,
        message:
          `Spec proposes route \`${entry.path}\` mapped to file \`${file}\` — ` +
          `that file already exists in the repo (likely an unrelated feature). ` +
          `Rename the spec's route OR relocate the existing file before brewing; ` +
          `brew would otherwise silently overwrite live code or pick a different path ad-hoc.`,
        action: "flagged",
      });
    }
  }
  return findings;
}
