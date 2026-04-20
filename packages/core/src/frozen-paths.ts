// Frozen-paths detection: pure functions, no I/O.
// The CLI (or any other consumer) reads git, config, and produces ChangedFile[];
// this module decides what counts as a violation.

export interface FrozenPathsConfig {
  /** Directory prefixes (with or without trailing slash). Any file under these is frozen. */
  directories?: string[];
  /** Exact file paths that are frozen in their entirety. */
  files?: string[];
  /** Partial freeze: specific JSON keys within a file (e.g., package.json's scripts.test). */
  partial?: Record<string, { frozen_key_paths?: string[] }>;
}

export interface Violation {
  file: string;
  rule: string;
}

export interface ChangedFile {
  path: string;
  /** Required only for files that appear in config.partial: JSON content at the base ref. */
  baseContent?: string;
  /** Required only for files that appear in config.partial: JSON content at the head ref. */
  headContent?: string;
}

export function checkFrozenPaths(
  changed: ChangedFile[],
  config: FrozenPathsConfig
): Violation[] {
  const violations: Violation[] = [];
  const dirs = config.directories ?? [];
  const files = config.files ?? [];
  const partial = config.partial ?? {};

  for (const f of changed) {
    for (const d of dirs) {
      const normalized = d.replace(/\/$/, "");
      if (
        f.path === normalized ||
        f.path.startsWith(d) ||
        f.path.startsWith(normalized + "/")
      ) {
        violations.push({ file: f.path, rule: `directory ${d}` });
        break;
      }
    }
    if (files.includes(f.path)) {
      violations.push({ file: f.path, rule: `exact file ${f.path}` });
    }
  }

  for (const [pfile, rules] of Object.entries(partial)) {
    const changedFile = changed.find((f) => f.path === pfile);
    if (!changedFile) continue;

    let baseJson: unknown = {};
    let headJson: unknown = {};
    try {
      if (changedFile.baseContent) baseJson = JSON.parse(changedFile.baseContent);
    } catch {
      // Malformed base — treat as empty so any head change registers as a violation.
    }
    try {
      if (changedFile.headContent) headJson = JSON.parse(changedFile.headContent);
    } catch {
      // Malformed head — not our problem, the diff is already visible.
    }

    for (const keyPath of rules.frozen_key_paths ?? []) {
      const baseVal = getNestedKey(baseJson, keyPath);
      const headVal = getNestedKey(headJson, keyPath);
      if (JSON.stringify(baseVal) !== JSON.stringify(headVal)) {
        violations.push({
          file: pfile,
          rule: `frozen key "${keyPath}" changed (${JSON.stringify(baseVal)} → ${JSON.stringify(headVal)})`,
        });
      }
    }
  }

  return violations;
}

function getNestedKey(obj: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((acc, key) => {
    if (acc && typeof acc === "object" && key in (acc as object)) {
      return (acc as Record<string, unknown>)[key];
    }
    return undefined;
  }, obj);
}
