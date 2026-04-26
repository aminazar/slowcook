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
