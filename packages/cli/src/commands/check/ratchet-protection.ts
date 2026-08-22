/**
 * RATCHET PROTECTION — an artifact may only be changed by the agent that owns it.
 *
 * The ratchet's claim is that an agent cannot move its own goalposts. That held
 * inside a brew run and nowhere else: any PR could hand-edit a spec or a test.
 * A toy fixture in this repo shipped a WALLET spec beside CART tests and every
 * stage accepted it — baseline ran, the spec slice reported `inv=13/13`, and a
 * refactor pass built the wallet the spec asked for.
 *
 * The general rule, enforced in CI on the diff:
 *
 *   Every OWNED artifact changes only through its owning agent, and only when
 *   that agent was initiated by an issue carrying the owner's label.
 *   Artifacts nobody owns stay editable by hand.
 *
 * There is deliberately NO human-override route. An "amend with a reason"
 * escape hatch reintroduces exactly what the ratchet exists to prevent: a
 * human — or an agent wearing a human's credentials — editing the definition
 * of done in the same PR that satisfies it. If a spec is wrong, the fix is to
 * run its owning agent from a labelled issue, so the change carries the same
 * provenance as every other change to that artifact.
 *
 * Ownership is configuration, not policy baked into slowcook:
 *
 *   tests   -> recipe        (issue label `agent:recipe`)
 *   specs   -> refine        (issue label `agent:refine`, story consent)
 *   stories -> pm-assistant  (issue label `pm:story-change`)   [dash]
 *
 * Pure module: the caller supplies the diff, the config, the ledger and the
 * issue metadata. Nothing here touches a filesystem or an API.
 */

/** One ownership rule from `.brewing/ownership.json`. */
export interface OwnershipRule {
  /** Human name of the artifact class, used in messages. */
  artifact: string;
  /** Path prefixes and/or exact paths this rule owns. */
  paths?: string[];
  /**
   * When true, the rule also owns every test file named by a story manifest.
   * Kept separate from `paths` because the manifest is the source of truth for
   * which tests are the oracle — a repo's own unit tests are not.
   */
  manifest_tests?: boolean;
  /** The ONLY agent permitted to change these files. */
  agent: string;
  /** The label the driving issue must carry. */
  issue_label: string;
  /**
   * Extra recorded consent the agent must capture — e.g. refine may only
   * change a spec if the owning story agrees. The gate verifies the RECORD
   * exists and names a story; it cannot judge whether the consent was real.
   * That honesty matters: this is provenance, not adjudication.
   */
  requires_story_consent?: boolean;
  /**
   * Derived-trigger reasons this rule accepts (e.g. the worker's
   * "(derived) tests-pr-review"). Omitted = any derived trigger recorded
   * WITH evidence by the owning agent is acceptable provenance; an empty
   * array means labelled issues only.
   */
  allowed_derived?: string[];
}

export interface OwnershipConfig {
  rules: OwnershipRule[];
}

/** An entry written by an agent when it authors owned files. */
export interface AuthoredEntry {
  agent: string;
  files: string[];
  /** sha256 of each file AS AUTHORED, keyed by path. */
  hashes: Record<string, string>;
  /** The issue that initiated the run. */
  issue?: number;
  /** Labels on that issue at the time of the run. */
  issue_labels?: string[];
  /** Story whose consent was recorded, when the rule demands it. */
  story_consent?: { story_id: string; evidence?: string };
  /**
   * Derived-trigger provenance (worker model: derived state, not label
   * state). A run the worker initiated without a labelled issue records
   * WHY it was derived and the evidence — the same reason string and
   * trace the worker's own audit trail carries. Either this or a
   * labelled issue authorises a change; both absent = unauthorised.
   */
  derived?: { reason: string; evidence: string; trace?: string };
  run_id?: string;
  at: string;
}

export interface ProtectionInput {
  changedPaths: string[];
  headHashes: Record<string, string>;
  ledger: AuthoredEntry[];
  /** The ledger's baseline header, written once by `slowcook provenance
   *  init` at adoption. Its ABSENCE while owned artifacts change is a
   *  setup error (`baseline-missing`), never a grace state. */
  baseline?: { commit: string; at: string; by: string } | null;
  config: OwnershipConfig;
  /** Test files named by story manifests. */
  manifestTestFiles?: string[];
}

export interface Violation {
  path: string;
  artifact: string;
  reason: string;
}

export interface ProtectionVerdict {
  ok: boolean;
  violations: Violation[];
  sanctioned: Array<{ path: string; artifact: string; agent: string; via: string }>;
  summary: string;
}

/** Which rule owns this path, if any. */
export function ruleFor(
  path: string,
  config: OwnershipConfig,
  manifestTestFiles: string[] = []
): OwnershipRule | null {
  for (const rule of config.rules) {
    if (rule.manifest_tests && manifestTestFiles.includes(path)) return rule;
    for (const p of rule.paths ?? []) {
      if (p.endsWith("/") ? path.startsWith(p) : path === p || path.startsWith(p.replace(/\*+$/, ""))) {
        // A bare prefix rule must not swallow unrelated siblings.
        if (p.includes("*") || p.endsWith("/") || path === p) return rule;
      }
    }
  }
  return null;
}

export function verifyProtection(input: ProtectionInput): ProtectionVerdict {
  const manifestTests = input.manifestTestFiles ?? [];
  const owned = input.changedPaths
    .map((path) => ({ path, rule: ruleFor(path, input.config, manifestTests) }))
    .filter((c): c is { path: string; rule: OwnershipRule } => c.rule !== null);

  if (owned.length === 0) {
    return {
      ok: true,
      violations: [],
      sanctioned: [],
      summary:
        "no owned artifacts changed" +
        (input.baseline ? "" : " (note: ratchet has no baseline — run `slowcook provenance init`)"),
    };
  }

  // Baseline at install, never backfill-on-gap (2026-08-22 ruling): the
  // gate judging owned changes without a baseline is a SETUP error.
  if (!input.baseline) {
    return {
      ok: false,
      violations: owned.map(({ path, rule }) => ({
        path,
        artifact: rule.artifact,
        reason:
          "the ratchet is armed but has no baseline — run `slowcook provenance init` once " +
          "(it grandfathers every owned artifact at HEAD in one commit, then enforcement is strict)",
      })),
      sanctioned: [],
      summary: "baseline-missing: owned artifacts changed before `slowcook provenance init` ran",
    };
  }

  const violations: Violation[] = [];
  const sanctioned: ProtectionVerdict["sanctioned"] = [];

  for (const { path, rule } of owned) {
    const entry = input.ledger.find((e) => e.files.includes(path));

    if (!entry) {
      violations.push({
        path,
        artifact: rule.artifact,
        reason:
          `changed by hand. ${rule.artifact} is owned by \`${rule.agent}\` — ` +
          `open an issue labelled \`${rule.issue_label}\` and let ${rule.agent} make the change.`,
      });
      continue;
    }

    // The right artifact, but the wrong agent, is still a violation: an agent
    // that owns tests must not be able to rewrite specs on the way past.
    if (entry.agent !== rule.agent) {
      violations.push({
        path,
        artifact: rule.artifact,
        reason: `authored by \`${entry.agent}\`, but ${rule.artifact} is owned by \`${rule.agent}\``,
      });
      continue;
    }

    // Content must still be what the agent wrote, or a PR could let the agent
    // author the file and then quietly edit it in the same diff.
    const authored = entry.hashes[path];
    const head = input.headHashes[path];
    if (!authored || !head || authored !== head) {
      violations.push({
        path,
        artifact: rule.artifact,
        reason:
          `\`${rule.agent}\` authored this, but the content at HEAD differs from what it wrote ` +
          `(authored ${(authored ?? "?").slice(0, 12)}, head ${(head ?? "?").slice(0, 12)}) — ` +
          `hand-editing an agent's output is the thing this gate exists to stop`,
      });
      continue;
    }

    // Authorisation: a labelled driving issue OR a recorded derived
    // trigger (the worker model — resubmits and regenerations are
    // initiated by reviews and drift, not labels). Both absent =
    // unauthorised; a derived record without evidence is no record.
    const labelled =
      entry.issue !== undefined && (entry.issue_labels ?? []).includes(rule.issue_label);
    const derivedOk =
      entry.derived !== undefined &&
      entry.derived.evidence.trim().length > 0 &&
      (rule.allowed_derived === undefined ||
        rule.allowed_derived.includes(entry.derived.reason));
    if (!labelled && !derivedOk) {
      violations.push({
        path,
        artifact: rule.artifact,
        reason:
          entry.derived !== undefined
            ? `derived trigger \`${entry.derived.reason}\` is not accepted for ${rule.artifact}` +
              (entry.derived.evidence.trim() ? "" : " (and records no evidence)")
            : entry.issue === undefined
              ? `\`${rule.agent}\` ran with neither a driving issue nor a recorded derived trigger — there is no stated reason a reviewer can follow`
              : `the driving issue #${entry.issue} does not carry \`${rule.issue_label}\` — ` +
                `the label is how a change to ${rule.artifact} is authorised, and it is checked on the ISSUE, ` +
                `not the PR, so it cannot be added after the fact by whoever opened the PR`,
      });
      continue;
    }

    if (rule.requires_story_consent && !entry.story_consent?.story_id) {
      violations.push({
        path,
        artifact: rule.artifact,
        reason:
          `\`${rule.agent}\` may only change ${rule.artifact} when the owning story agrees, ` +
          `and no story consent was recorded`,
      });
      continue;
    }

    sanctioned.push({
      path,
      artifact: rule.artifact,
      agent: rule.agent,
      via: labelled ? `issue #${entry.issue}` : `derived: ${entry.derived!.reason}`,
    });
  }

  const ok = violations.length === 0;
  return {
    ok,
    violations,
    sanctioned,
    summary: ok
      ? `${sanctioned.length} owned artifact(s) changed, all through their owning agent`
      : `${violations.length} unauthorised change(s) to owned artifacts`,
  };
}

export function renderVerdict(v: ProtectionVerdict): string {
  const lines: string[] = [];
  if (v.ok) {
    lines.push(`✓ ratchet-protection: ${v.summary}`);
    for (const s of v.sanctioned) lines.push(`  · ${s.path} — ${s.agent}, ${s.via}`);
    return lines.join("\n");
  }
  lines.push(`✗ ratchet-protection: ${v.summary}`);
  lines.push("");
  lines.push("An artifact an agent is responsible for may only be changed by that agent,");
  lines.push("initiated by a correctly labelled issue. There is no hand-edit route: an");
  lines.push("override would let the definition of done move in the same PR that claims");
  lines.push("to satisfy it.");
  lines.push("");
  for (const x of v.violations) lines.push(`  ${x.artifact}  ${x.path}\n      ${x.reason}`);
  return lines.join("\n");
}

/** Shipped default: tests belong to recipe, specs to refine. */
export const DEFAULT_OWNERSHIP: OwnershipConfig = {
  rules: [
    { artifact: "story tests", manifest_tests: true, agent: "recipe", issue_label: "agent:recipe" },
    {
      artifact: "specs",
      paths: ["specs/"],
      agent: "refine",
      issue_label: "agent:refine",
      requires_story_consent: true,
    },
  ],
};
