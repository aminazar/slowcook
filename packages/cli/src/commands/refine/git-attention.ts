/**
 * @slowcook 0.19.0-alpha.43 — git-history attention layer for the refine
 * history-index.
 *
 * Motivated by the "Attention Is All You Need" thread (memory:
 * project_bounded_attention_validation_2026_04_25): a brownfield repo IS
 * the product of a sequential process (git commits). Versioning history
 * — diffs, commit messages, PR descriptions, specs — is a strong signal
 * for which existing components/props/tests/routes/migrations are most
 * relevant to a new story, BUT raw commit history is noisy. We extract
 * four narrower signals:
 *
 *   1. Rename chains       — `git log --follow` so look-ups don't miss
 *                            historical names (e.g. ReactionsPage →
 *                            MemberReactionsPage).
 *   2. Change-coupling     — file pairs that co-change in the same
 *                            commits; surfaces architectural couplings
 *                            file-system layout misses.
 *   3. Recent PRs per file — PR descriptions are higher-quality "Keys"
 *                            than raw commit messages because they're
 *                            intent-shaped, not change-shaped.
 *   4. PR+spec corpus      — flat searchable index of PR descriptions
 *                            and spec yaml summaries so downstream agents
 *                            can keyword-retrieve prior intent before
 *                            writing new code.
 *
 * Deliberately deterministic (no embeddings). Embedding upgrade is a
 * future Phase 3 step; this lower-cost version ships the contract first.
 *
 * All four are graceful-degradation: missing git history, missing gh,
 * unauthenticated gh, no PRs, no specs — each path returns an empty
 * structure plus a warning string. The orchestrator NEVER throws.
 */

import { execSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";

export interface CoChangeEntry {
  /** repo-relative path of the co-changing file */
  file: string;
  /** fraction of this file's co-change events that landed on `file` (0..1, 2dp) */
  strength: number;
}

export interface PRRecord {
  number: number;
  title: string;
  body: string;
  merged_at: string | null;
  files: string[];
}

export interface PRSpecCorpusEntry {
  source: "pr" | "spec";
  /** Stable id: "pr#123" or "spec:story-007". */
  id: string;
  title: string;
  /** First ~500 chars of the body / spec summary. */
  excerpt: string;
  /** Files touched (empty for specs). */
  files_touched: string[];
  /** ISO date or "" if not applicable. */
  date: string;
  /** Lower-cased, stopword-stripped tokens for cheap keyword retrieval. */
  tokens: string[];
}

export interface GitAttentionData {
  enriched_at: string;
  /** current_file -> historical paths it was renamed from, newest-first. */
  rename_chains: Record<string, string[]>;
  /** file -> top-K co-changing files (by frequency in same commits). */
  co_changes: Record<string, CoChangeEntry[]>;
  /** file -> last 5 PRs that touched it (newest-first; merged before open). */
  recent_prs_by_file: Record<string, PRRecord[]>;
  /** Flat searchable corpus of PR descriptions + spec yaml summaries. */
  pr_spec_corpus: PRSpecCorpusEntry[];
  /** Non-fatal degradation notices ("gh not installed", "git history shallow", etc.). */
  warnings: string[];
}

export interface GitAttentionOptions {
  repoRoot: string;
  /** Files we want enrichment for (typically the union of components/api/tests/migrations from the history index). */
  trackedFiles: string[];
  /** Months of git log to consider for co-change. Default 6. */
  coChangeWindowMonths?: number;
  /** Skip commits with more files than this (mass refactor filter). Default 50. */
  coChangeMaxFilesPerCommit?: number;
  /** How many co-changes to keep per file. Default 5. */
  coChangesPerFile?: number;
  /** How many recent PRs to fetch from gh. Default 50. */
  prsToFetch?: number;
  /** Injectable for tests: override `git -C <root> ...` */
  gitExec?: (cmd: string) => string;
  /** Injectable for tests: override `gh ...` */
  ghExec?: (cmd: string) => string;
}

export function computeGitAttention(opts: GitAttentionOptions): GitAttentionData {
  const warnings: string[] = [];
  const git = opts.gitExec ?? defaultGit(opts.repoRoot);
  const gh = opts.ghExec ?? defaultGh();

  let isRepo = true;
  try {
    git("rev-parse --git-dir");
  } catch (e) {
    isRepo = false;
    warnings.push(`Not a git repo (${(e as Error).message.slice(0, 80)}); git-history signals skipped.`);
  }

  let rename_chains: Record<string, string[]> = {};
  let co_changes: Record<string, CoChangeEntry[]> = {};

  if (isRepo) {
    try {
      rename_chains = computeRenameChains(opts.trackedFiles, git);
    } catch (e) {
      warnings.push(`Rename detection failed: ${(e as Error).message.slice(0, 120)}`);
    }
    try {
      co_changes = computeCoChanges(opts.trackedFiles, git, {
        windowMonths: opts.coChangeWindowMonths ?? 6,
        maxFilesPerCommit: opts.coChangeMaxFilesPerCommit ?? 50,
        topPerFile: opts.coChangesPerFile ?? 5,
      });
    } catch (e) {
      warnings.push(`Co-change matrix failed: ${(e as Error).message.slice(0, 120)}`);
    }
  }

  let prs: PRRecord[] = [];
  let recent_prs_by_file: Record<string, PRRecord[]> = {};
  try {
    prs = fetchRecentPRs(gh, opts.prsToFetch ?? 50);
    recent_prs_by_file = indexPRsByFile(prs, opts.trackedFiles);
  } catch (e) {
    warnings.push(
      `gh pr list failed (PR-as-Key signal skipped): ${(e as Error).message.slice(0, 120)}`
    );
  }

  let pr_spec_corpus: PRSpecCorpusEntry[] = [];
  try {
    pr_spec_corpus = buildPRSpecCorpus(prs, opts.repoRoot);
  } catch (e) {
    warnings.push(`PR+spec corpus build failed: ${(e as Error).message.slice(0, 120)}`);
  }

  return {
    enriched_at: new Date().toISOString(),
    rename_chains,
    co_changes,
    recent_prs_by_file,
    pr_spec_corpus,
    warnings,
  };
}

// ─── git/gh execution shims ─────────────────────────────────────────────

function defaultGit(repoRoot: string) {
  return (cmd: string) =>
    execSync(`git -C "${repoRoot}" ${cmd}`, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 50 * 1024 * 1024,
    });
}

function defaultGh() {
  return (cmd: string) =>
    execSync(`gh ${cmd}`, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 50 * 1024 * 1024,
    });
}

// ─── rename chains ──────────────────────────────────────────────────────

export function computeRenameChains(
  files: string[],
  git: (cmd: string) => string
): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const file of files) {
    if (file.includes('"') || file.includes("`")) continue; // refuse shell-injection candidates
    let stdout = "";
    try {
      stdout = git(`log --follow --name-status -M --pretty=format:"" -- "${file}"`);
    } catch {
      continue; // per-file failures are fine (file may not be tracked)
    }
    const chain = parseRenameChain(stdout, file);
    if (chain.length > 0) out[file] = chain;
  }
  return out;
}

/**
 * Parse `git log --follow --name-status -M` output for a single file.
 * Each rename is a line `R<score>\told\tnew`. Returns OLD paths in the
 * order git reports them (newest commit first, so most-recent rename
 * is index 0).
 */
export function parseRenameChain(stdout: string, currentFile: string): string[] {
  const renames: string[] = [];
  for (const rawLine of stdout.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    if (!line.startsWith("R")) continue;
    const parts = line.split("\t");
    if (parts.length < 3) continue;
    const oldPath = parts[1]!;
    if (oldPath === currentFile) continue;
    if (renames.includes(oldPath)) continue;
    renames.push(oldPath);
  }
  return renames;
}

// ─── co-change matrix ───────────────────────────────────────────────────

export interface CoChangeBuildOptions {
  windowMonths: number;
  maxFilesPerCommit: number;
  topPerFile: number;
}

export function computeCoChanges(
  trackedFiles: string[],
  git: (cmd: string) => string,
  opts: CoChangeBuildOptions
): Record<string, CoChangeEntry[]> {
  const since = isoDaysAgo(opts.windowMonths * 30);
  const stdout = git(`log --name-only --pretty=format:"COMMIT %H" --since="${since}"`);
  const commits = parseLogIntoCommits(stdout);

  const tracked = new Set(trackedFiles);
  const counts = new Map<string, Map<string, number>>();
  for (const file of trackedFiles) counts.set(file, new Map());

  for (const commit of commits) {
    if (commit.files.length === 0 || commit.files.length > opts.maxFilesPerCommit) continue;
    if (!commit.files.some((f) => tracked.has(f))) continue;
    for (const a of commit.files) {
      if (!tracked.has(a)) continue;
      const aMap = counts.get(a)!;
      for (const b of commit.files) {
        if (b === a) continue;
        aMap.set(b, (aMap.get(b) ?? 0) + 1);
      }
    }
  }

  const out: Record<string, CoChangeEntry[]> = {};
  for (const [file, others] of counts) {
    if (others.size === 0) continue;
    const total = Array.from(others.values()).reduce((s, n) => s + n, 0);
    const sorted = Array.from(others.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, opts.topPerFile)
      .map(([f, c]) => ({ file: f, strength: round2(c / Math.max(total, 1)) }));
    out[file] = sorted;
  }
  return out;
}

export function parseLogIntoCommits(
  stdout: string
): Array<{ sha: string; files: string[] }> {
  const commits: Array<{ sha: string; files: string[] }> = [];
  let current: { sha: string; files: string[] } | null = null;
  for (const rawLine of stdout.split("\n")) {
    const line = rawLine.trim();
    if (line.startsWith("COMMIT ")) {
      if (current) commits.push(current);
      current = { sha: line.slice("COMMIT ".length), files: [] };
    } else if (line.length > 0 && current) {
      current.files.push(line);
    }
  }
  if (current) commits.push(current);
  return commits;
}

function isoDaysAgo(days: number): string {
  const d = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  return d.toISOString().slice(0, 10);
}

function round2(x: number): number {
  return Math.round(x * 100) / 100;
}

// ─── recent PRs via gh ──────────────────────────────────────────────────

export function fetchRecentPRs(
  gh: (cmd: string) => string,
  limit: number
): PRRecord[] {
  const stdout = gh(`pr list --state all --limit ${limit} --json number,title,body,mergedAt,files`);
  return parseGhPRList(stdout);
}

export function parseGhPRList(stdout: string): PRRecord[] {
  let raw: unknown;
  try {
    raw = JSON.parse(stdout);
  } catch {
    return [];
  }
  if (!Array.isArray(raw)) return [];
  const out: PRRecord[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const filesField = o.files;
    const files: string[] = Array.isArray(filesField)
      ? filesField
          .map((f) =>
            f && typeof f === "object"
              ? ((f as Record<string, unknown>).path as unknown)
              : null
          )
          .filter((p): p is string => typeof p === "string")
      : [];
    out.push({
      number: typeof o.number === "number" ? o.number : 0,
      title: typeof o.title === "string" ? o.title : "",
      body: typeof o.body === "string" ? o.body : "",
      merged_at: typeof o.mergedAt === "string" ? o.mergedAt : null,
      files,
    });
  }
  return out;
}

export function indexPRsByFile(
  prs: PRRecord[],
  files: string[]
): Record<string, PRRecord[]> {
  const out: Record<string, PRRecord[]> = {};
  const tracked = new Set(files);
  for (const pr of prs) {
    for (const f of pr.files) {
      if (!tracked.has(f)) continue;
      (out[f] ??= []).push(pr);
    }
  }
  for (const key of Object.keys(out)) {
    out[key]!.sort((a, b) => {
      if (a.merged_at === b.merged_at) return b.number - a.number;
      if (!a.merged_at) return -1; // open PRs first
      if (!b.merged_at) return 1;
      return a.merged_at < b.merged_at ? 1 : -1;
    });
    out[key] = out[key]!.slice(0, 5);
  }
  return out;
}

// ─── PR + spec corpus ───────────────────────────────────────────────────

const STOPWORDS = new Set([
  "the","and","for","with","that","this","from","into","over","under",
  "when","where","what","how","why","not","but","you","your","our","its",
  "are","was","were","has","have","had","can","may","might","will","would",
  "should","could","does","did","done","than","then","also","just","like",
  "use","using","used","make","made","get","got","set","new","old","add",
  "added","fix","fixed","update","updated","remove","removed","pull",
  "request","merge","branch","commit","file","files","code","main","alpha",
  "beta","wip","tbd","docs","doc","feat","chore","refactor","src","test","tests",
]);

/**
 * Lowercase, stopword-stripped, deduped token list capped at 60. Cheap
 * substitute for embeddings — agents can intersect query tokens with
 * each corpus entry's `tokens` to rank relevance without an LLM call.
 *
 * Embedding upgrade is Phase 3 (slowcook 0.14.0+, evidence-gated). Until
 * then this is what we ship.
 */
export function tokeniseForCorpus(text: string): string[] {
  const raw = text.toLowerCase().match(/[a-z][a-z0-9_-]{2,}/g) ?? [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const tok of raw) {
    if (STOPWORDS.has(tok)) continue;
    if (seen.has(tok)) continue;
    seen.add(tok);
    out.push(tok);
    if (out.length >= 60) break;
  }
  return out;
}

export function buildPRSpecCorpus(
  prs: PRRecord[],
  repoRoot: string
): PRSpecCorpusEntry[] {
  const out: PRSpecCorpusEntry[] = [];
  for (const pr of prs) {
    out.push({
      source: "pr",
      id: `pr#${pr.number}`,
      title: pr.title,
      excerpt: trimExcerpt(pr.body, 500),
      files_touched: pr.files,
      date: pr.merged_at ?? "",
      tokens: tokeniseForCorpus(`${pr.title}\n${pr.body}\n${pr.files.join(" ")}`),
    });
  }
  const specsDir = join(repoRoot, "specs");
  if (existsSync(specsDir)) {
    let entries: string[] = [];
    try {
      entries = readdirSync(specsDir)
        .filter((f) => f.endsWith(".yaml") || f.endsWith(".yml"))
        .sort();
    } catch {
      return out;
    }
    for (const name of entries) {
      const full = join(specsDir, name);
      let raw = "";
      try {
        raw = readFileSync(full, "utf8");
      } catch {
        continue;
      }
      let title = "";
      let summary = "";
      try {
        const parsed = YAML.parse(raw) as Record<string, unknown> | null;
        if (parsed && typeof parsed === "object") {
          title = typeof parsed.title === "string" ? parsed.title : "";
          summary = typeof parsed.summary === "string" ? parsed.summary : "";
        }
      } catch {
        // malformed yaml — index raw text anyway
      }
      out.push({
        source: "spec",
        id: `spec:${name.replace(/\.(yaml|yml)$/, "")}`,
        title,
        excerpt: summary || trimExcerpt(raw, 500),
        files_touched: [],
        date: "",
        tokens: tokeniseForCorpus(`${title}\n${summary}\n${raw}`),
      });
    }
  }
  return out;
}

function trimExcerpt(text: string, limit: number): string {
  const trimmed = (text || "").trim();
  if (trimmed.length <= limit) return trimmed;
  return trimmed.slice(0, limit) + " …";
}
