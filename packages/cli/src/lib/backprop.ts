/**
 * Backprop claims — the storyteller practice's feedback channel to earlier
 * artifacts. When journey compilation, a walk, or the checker discovers a
 * gap that belongs upstream (PRD, stories, concept, wireframe), it files a
 * CLAIM instead of silently working around it.
 *
 * Claims are ALWAYS mirrored to `.brewing/backprop-claims.json` (offline and
 * dry-run safe — `greenfield status` counts open claims from the mirror
 * without API calls). When a GitHub repo is configured, each claim is also
 * filed as an issue labeled `backprop-claim` + `backprop:<target>` so it
 * enters the standing review loop.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

export type BackpropTarget = "prd" | "stories" | "concept" | "wire";

export interface BackpropClaim {
  target: BackpropTarget;
  /** One-line defect statement. */
  summary: string;
  /** What exactly is missing/contradicted and what the walker needed. */
  detail: string;
  /** Where the claim arose (journey/step/walk/check id or artifact ref). */
  source: string;
  /** #558 — the story issue this claim belongs to, when the caller knows
   *  it. Rendered as `#N` in the claim body, so GitHub cross-links the
   *  claim onto the story issue's timeline (the story-thread rule:
   *  everything about a story is visible from its issue). */
  storyIssue?: number;
}

export interface StoredClaim extends BackpropClaim {
  id: string;
  status: "open" | "resolved";
  filedAt: string;
  issueNumber?: number;
}

const MIRROR = ".brewing/backprop-claims.json";

export function loadClaims(cwd: string): StoredClaim[] {
  const p = resolve(cwd, MIRROR);
  if (!existsSync(p)) return [];
  try { return JSON.parse(readFileSync(p, "utf8")) as StoredClaim[]; } catch { return []; }
}

export function openClaimCount(cwd: string): number {
  return loadClaims(cwd).filter((c) => c.status === "open").length;
}

function saveClaims(cwd: string, claims: StoredClaim[]): void {
  const p = resolve(cwd, MIRROR);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(claims, null, 2) + "\n");
}

const claimKey = (c: BackpropClaim) => `${c.target}::${c.summary}`;

export interface FileClaimsResult {
  mirrored: number;
  issued: number;
  skippedDuplicates: number;
  /** Issue numbers actually filed this call (#558 — callers cite them
   *  on the story thread instead of saying "a claim was filed"). */
  issuedNumbers: number[];
}

/**
 * Record claims: dedupe against the mirror (open claims with the same
 * target+summary are not re-filed), then attempt issue creation when a
 * forge is reachable. Issue failures degrade to mirror-only, never throw.
 */
export async function fileBackpropClaims(cwd: string, claims: BackpropClaim[], opts?: { now?: () => string }): Promise<FileClaimsResult> {
  const existing = loadClaims(cwd);
  const openKeys = new Set(existing.filter((c) => c.status === "open").map(claimKey));
  // Dedupe against the mirror AND within the batch — one screen missing a
  // route is ONE claim, however many journeys trip over it.
  const fresh: BackpropClaim[] = [];
  for (const c of claims) {
    const k = claimKey(c);
    if (openKeys.has(k)) continue;
    openKeys.add(k);
    fresh.push(c);
  }
  const now = opts?.now ?? (() => new Date().toISOString());

  const stored: StoredClaim[] = fresh.map((c, i) => ({
    ...c,
    id: `bp-${Date.now().toString(36)}-${i}`,
    status: "open",
    filedAt: now(),
  }));

  let issued = 0;
  const adapter = await tryForgeAdapter(cwd);
  if (adapter) {
    for (const c of stored) {
      try {
        const issue = await adapter.createIssue({
          title: `[backprop:${c.target}] ${c.summary}`,
          body:
            `**Backprop claim** — a downstream stage found a gap that belongs to the ${c.target}.\n\n` +
            `${c.detail}\n\n**Source:** ${c.source}\n` +
            (c.storyIssue ? `**Story thread:** #${c.storyIssue}\n` : "") +
            `\n_Filed by the storyteller practice; resolve by amending the ${c.target}, then mark this claim resolved._`,
          labels: ["backprop-claim", `backprop:${c.target}`],
        });
        c.issueNumber = issue.number;
        issued++;
      } catch {
        /* offline / no permission — mirror-only is the contract */
      }
    }
  }

  saveClaims(cwd, [...existing, ...stored]);
  return {
    mirrored: stored.length,
    issued,
    skippedDuplicates: claims.length - fresh.length,
    issuedNumbers: stored
      .map((c) => c.issueNumber)
      .filter((n): n is number => n !== undefined),
  };
}

async function tryForgeAdapter(cwd: string): Promise<{ createIssue: (i: { title: string; body: string; labels: string[] }) => Promise<{ number: number }> } | null> {
  const token = process.env["GITHUB_TOKEN"];
  if (!token) return null;
  try {
    const { execSync } = await import("node:child_process");
    const url = execSync("git remote get-url origin", { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    const m = url.match(/github\.com[:/]([^/]+)\/([^/.]+)(?:\.git)?$/);
    if (!m || !m[1] || !m[2]) return null;
    const { GitHubAdapter } = await import("@slowcook-ai/forge-github");
    return new GitHubAdapter({ owner: m[1], repo: m[2], token });
  } catch {
    return null;
  }
}
