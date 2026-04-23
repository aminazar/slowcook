import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";

export interface StalenessCheckOptions {
  /** Root directory where fixtures live. Default `tests/fixtures`. */
  fixturesRoot?: string;
  /** Story id to check — default = every story directory under root. */
  storyId?: string;
  /** Fixtures older than this many days are flagged. Default 14. */
  maxAgeDays?: number;
  /** Override current time (for testing). Default = now. */
  now?: Date;
}

export interface StaleFixture {
  path: string;
  ageDays: number;
  recordedAt: string | null;
}

/**
 * Scan fixture files; return those older than the threshold. Fixtures
 * carry a `recorded_at` ISO timestamp field set when the recorder wrote
 * them; we trust that field over the filesystem mtime (so CI clones
 * with fresh mtimes don't look artificially new). Falls back to mtime
 * if the field is missing (older fixtures).
 *
 * Spec-level exemption: if the story's spec has a `@fixtures-frozen
 * <reason>` marker, the story's fixtures skip the staleness check.
 * (Marker handling is in the CLI command — this function returns raw
 * stale fixtures; the CLI applies the exemption.)
 */
export function findStaleFixtures(options: StalenessCheckOptions = {}): StaleFixture[] {
  const root = options.fixturesRoot ?? "tests/fixtures";
  const maxAgeDays = options.maxAgeDays ?? 14;
  const now = options.now ?? new Date();
  const cutoff = now.getTime() - maxAgeDays * 24 * 60 * 60 * 1000;

  if (!existsSync(root)) return [];

  const stale: StaleFixture[] = [];
  const storyDirs = options.storyId
    ? [`story-${options.storyId}`]
    : readdirSync(root).filter((d) => d.startsWith("story-"));

  for (const storyDir of storyDirs) {
    const abs = join(root, storyDir);
    if (!existsSync(abs)) continue;
    walk(abs, (filePath) => {
      if (!filePath.endsWith(".json")) return;
      const recordedAt = readRecordedAt(filePath);
      const effectiveMs = recordedAt ? recordedAt.getTime() : statSync(filePath).mtimeMs;
      if (effectiveMs < cutoff) {
        stale.push({
          path: filePath,
          ageDays: Math.floor((now.getTime() - effectiveMs) / (24 * 60 * 60 * 1000)),
          recordedAt: recordedAt ? recordedAt.toISOString() : null,
        });
      }
    });
  }
  return stale;
}

function walk(dir: string, visit: (path: string) => void): void {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, visit);
    else if (st.isFile()) visit(full);
  }
}

function readRecordedAt(path: string): Date | null {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    if (parsed && typeof parsed === "object" && typeof parsed.recorded_at === "string") {
      const d = new Date(parsed.recorded_at);
      if (!isNaN(d.getTime())) return d;
    }
  } catch {
    /* malformed fixture — fall through to mtime */
  }
  return null;
}
