/**
 * `slowcook extract --survey` — tier 0 of #262: the deterministic brownfield
 * survey. What a founder expects the moment an existing repo is connected:
 * the documents it already holds (dated — stale ones stay honest), its story
 * history, and the work evidence git/GitHub carry. No LLM, no network beyond
 * optional `gh` (skipped honestly when unavailable).
 *
 * Emits `.brewing/extract-survey.json` whose entries are knowledge-claim
 * shaped ({source, area, statement, status, evidence}) so consumers (dash's
 * knowledge sync, or any §7.18-style intake) can ingest them directly.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";

export interface SurveyClaim {
  source: "doc" | "extraction";
  area: "product" | "behaviour" | "brand" | "architecture" | "data";
  statement: string;
  status: "unverified" | "verified";
  evidence: Record<string, unknown>;
  doc_name?: string;
}

export interface SurveyOutput {
  generated_at: string;
  repo_head: string | null;
  claims: SurveyClaim[];
  skipped: string[];
}

const DOC_AREA: { re: RegExp; area: SurveyClaim["area"] }[] = [
  { re: /brand|design|theme|style/i, area: "brand" },
  { re: /architec|deploy|infra|stack|engineering|supabase|setup|operations|ops\b/i, area: "architecture" },
  { re: /schema|migration|data\b|ddl/i, area: "data" },
  { re: /prd|readme|product|vision|stories|spec|roadmap|changelog/i, area: "product" },
];
const areaFor = (path: string): SurveyClaim["area"] =>
  DOC_AREA.find((d) => d.re.test(path))?.area ?? "product";

const isDocPath = (p: string): boolean =>
  (/\.(md|mdx|txt|rst)$/i.test(p) || /^\.brewing\/[^/]+\.ya?ml$/i.test(p) || /brand[^/]*\.ya?ml$/i.test(p)) &&
  !/node_modules|^\.github\/|CODE_OF_CONDUCT|LICENSE/i.test(p) && p.split("/").length <= 4;

function walk(dir: string, root: string, acc: string[] = []): string[] {
  let entries: string[];
  try { entries = readdirSync(dir); } catch { return acc; }
  for (const name of entries) {
    if (name === "node_modules" || name === ".git" || name === "dist") continue;
    const full = join(dir, name);
    let st;
    try { st = statSync(full); } catch { continue; }
    if (st.isDirectory()) walk(full, root, acc);
    else acc.push(relative(root, full).replace(/\\/g, "/"));
  }
  return acc;
}

function git(root: string, args: string[]): string | null {
  try { return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); }
  catch { return null; }
}

function gh(root: string, args: string[]): string | null {
  try { return execFileSync("gh", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); }
  catch { return null; }
}

const firstHeading = (body: string): string | null =>
  body.split("\n").find((l) => l.startsWith("# "))?.slice(2).trim() ?? null;

function datedSuffix(iso: string | null, now: Date): string {
  if (!iso) return "";
  const months = Math.floor((now.getTime() - Date.parse(iso)) / (30 * 86_400_000));
  if (Number.isNaN(months)) return "";
  return months >= 1
    ? ` — last touched ${months} month${months === 1 ? "" : "s"} ago${months >= 6 ? " (may be stale)" : ""}`
    : " — recently updated";
}

export function runSurvey(repoRoot: string, now = new Date()): SurveyOutput {
  const claims: SurveyClaim[] = [];
  const skipped: string[] = [];
  const paths = walk(repoRoot, repoRoot);
  const head = git(repoRoot, ["rev-parse", "--short", "HEAD"]);

  // 1) document catalog, dated via git.
  for (const p of paths.filter(isDocPath).sort().slice(0, 60)) {
    let title: string | null = null;
    try { title = firstHeading(readFileSync(join(repoRoot, p), "utf8")); } catch { /* binary/unreadable */ }
    const iso = git(repoRoot, ["log", "-1", "--format=%cI", "--", p]);
    claims.push({
      source: "doc", area: areaFor(p), status: "unverified",
      statement: `Repo document: ${p}${title ? ` — “${title}”` : ""}${datedSuffix(iso, now)}`,
      evidence: { path: p, last_commit: iso, kind: "doc-catalog" },
      doc_name: p,
    });
  }

  // 2) story specs — one aggregate claim.
  const specs = paths.filter((p) => /^specs\/story-\d+\.ya?ml$/.test(p)).sort();
  if (specs.length > 0) {
    const titles: string[] = [];
    for (const p of specs.slice(0, 25)) {
      try {
        const t = readFileSync(join(repoRoot, p), "utf8").split("\n").find((l) => /^title:/.test(l))
          ?.replace(/^title:\s*/, "").replace(/^["']|["']$/g, "").trim();
        if (t) titles.push(`${p.replace(/^specs\//, "").replace(/\.ya?ml$/, "")}: ${t}`);
      } catch { /* skip */ }
    }
    let statusBit = "";
    try {
      const index = readFileSync(join(repoRoot, "specs/_index.yaml"), "utf8");
      const active = (index.match(/status:\s*active/g) ?? []).length;
      const superseded = (index.match(/status:\s*superseded/g) ?? []).length;
      statusBit = ` (${active} active, ${superseded} superseded per specs/_index.yaml)`;
    } catch { /* no index */ }
    const sample = titles.slice(0, 3).map((t) => `“${t.split(": ").slice(1).join(": ").slice(0, 60)}”`).join(" · ");
    claims.push({
      source: "extraction", area: "product", status: "verified",
      statement: `Story history: ${specs.length} committed story specs${statusBit}${sample ? ` — e.g. ${sample}` : ""}.`,
      evidence: { kind: "story-specs", titles },
    });
  }

  // 3) work evidence — git always; GitHub via `gh` when available.
  const commitCount = git(repoRoot, ["rev-list", "--count", "HEAD"]);
  const recent = git(repoRoot, ["log", "-20", "--format=%s"])?.split("\n").filter(Boolean) ?? [];
  const lastIso = git(repoRoot, ["log", "-1", "--format=%cI"]);
  const branches = git(repoRoot, ["branch", "-r", "--format=%(refname:short)"])?.split("\n")
    .map((b) => b.replace(/^origin\//, "")).filter((b) => b && b !== "HEAD") ?? [];
  const conventions: Record<string, number> = {};
  for (const b of branches) {
    const prefix = b.includes("/") ? `${b.split("/")[0]}/*` : "(bare)";
    conventions[prefix] = (conventions[prefix] ?? 0) + 1;
  }
  const conv = Object.entries(conventions).sort((a, b) => b[1] - a[1]).slice(0, 2).map(([k, n]) => `${k} ×${n}`).join(", ");
  if (commitCount) {
    claims.push({
      source: "extraction", area: "architecture", status: "verified",
      statement: `Commit history: ${commitCount} commits${lastIso ? `, last${datedSuffix(lastIso, now).replace(" — last touched", "")}` : ""}; ${branches.length} remote branches${conv ? ` (mostly ${conv})` : ""}. Recent: ${recent.slice(0, 2).map((m) => `“${m}”`).join(" · ")}`,
      evidence: { kind: "commit-sample", messages: recent, branches: conventions, last_commit: lastIso },
    });
  } else {
    skipped.push("git history (not a git checkout)");
  }
  const issueJson = gh(repoRoot, ["issue", "list", "--state", "all", "--limit", "100", "--json", "state,title"]);
  const prJson = gh(repoRoot, ["pr", "list", "--state", "all", "--limit", "100", "--json", "state,title"]);
  if (issueJson && prJson) {
    try {
      const issues = JSON.parse(issueJson) as { state: string; title: string }[];
      const prs = JSON.parse(prJson) as { state: string; title: string }[];
      claims.push({
        source: "extraction", area: "product", status: "verified",
        statement: `Work evidence: ${issues.length} issues (${issues.filter((i) => i.state === "OPEN").length} open), ${prs.length} PRs (${prs.filter((p) => p.state === "MERGED").length} merged).`,
        evidence: { kind: "work-evidence", issues: issues.slice(0, 8), pulls: prs.slice(0, 8) },
      });
    } catch { skipped.push("GitHub issues/PRs (gh output unparseable)"); }
  } else {
    skipped.push("GitHub issues/PRs (gh unavailable or no remote access)");
  }

  return { generated_at: now.toISOString(), repo_head: head, claims, skipped };
}

export function writeSurvey(repoRoot: string, out: SurveyOutput): string {
  const dir = join(repoRoot, ".brewing");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const file = join(dir, "extract-survey.json");
  writeFileSync(file, JSON.stringify(out, null, 2) + "\n", "utf8");
  return file;
}
