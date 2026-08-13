/**
 * PROJECT SCOPE — story numbering is per-project, branches are per-REPO
 * (dovizir handover §3).
 *
 * Two slowcook projects in one git repo (`packages/contracts/.brewing`,
 * `packages/notes/.brewing`) both numbered their first story `001`, so two
 * parallel refines both ran `git checkout -b slowcook/spec/story-001` and the
 * second died: `fatal: a branch named 'slowcook/spec/story-001' already
 * exists`. Nothing was wrong with either project — the namespace was simply
 * repo-wide while the numbering was not.
 *
 * The scope qualifies the shared namespace:
 *   single-project repo → ""                    → `slowcook/spec/story-001`
 *   monorepo            → "packages-contracts"  → `slowcook/spec/packages-contracts/story-001`
 *
 * A repo whose `.brewing` sits at the git root derives an EMPTY scope, so
 * every existing branch name is unchanged and no consumer needs to migrate.
 */

/** Path segment → branch-safe slug. Git refs forbid a lot; keep it boring. */
export function slugifyScope(raw: string): string {
  return raw
    .trim()
    .replace(/^[./]+|[./]+$/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

export interface ScopeInput {
  /** Directory holding this project's `.brewing` (the slowcook project root). */
  repoRoot: string;
  /** Git worktree root, or null when not in a git repo / lookup failed. */
  gitRoot: string | null;
  /** Explicit override from stack.json `project_id`. Wins when present. */
  projectId?: string | undefined;
}

/**
 * Derive the scope. Empty string means "unscoped" — the single-project case,
 * which must keep today's names exactly.
 */
export function deriveScope(input: ScopeInput): string {
  if (input.projectId?.trim()) return slugifyScope(input.projectId);
  if (!input.gitRoot) return "";
  const root = input.gitRoot.replace(/\/+$/, "");
  const proj = input.repoRoot.replace(/\/+$/, "");
  if (proj === root) return "";
  if (!proj.startsWith(root + "/")) return ""; // outside the worktree — don't invent one
  return slugifyScope(proj.slice(root.length + 1));
}

/** `slowcook/spec/story-001` or `slowcook/spec/<scope>/story-001`. */
export function scopedSpecBranch(scope: string, storyId: string, suffix?: string): string {
  const tail = `story-${storyId}${suffix ? `-${suffix}` : ""}`;
  return scope ? `slowcook/spec/${scope}/${tail}` : `slowcook/spec/${tail}`;
}

/**
 * Match any spec branch for a story across scopes — used when scanning remote
 * branches for story-id collisions, which must not go blind to scoped repos.
 */
export function specBranchPattern(storyId = "*"): RegExp {
  const id = storyId === "*" ? "[^/]+" : storyId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^slowcook/spec/(?:[^/]+/)?story-${id}(?:-|$)`);
}

/** "spec: story-001 — title" or "spec: [contracts] story-001 — title". */
export function scopedPrTitle(scope: string, storyId: string, title: string): string {
  const tag = scope ? `[${scope}] ` : "";
  return `spec: ${tag}story-${storyId} — ${title}`;
}
