/**
 * `slowcook vibe --as-built --from <srcPath>` — #263: generate a FAITHFUL
 * mock of an EXISTING surface from its production source (lazy brownfield
 * mocking). Where normal vibe designs from a spec (mock-first), as-built
 * vibe transcribes from code (prod-first): the mock is a reviewable
 * re-render of what IS, stamped with its provenance so the parity baseline
 * can tell staleness (prod moved) from mutation (mock edited).
 *
 * Uses the shared LlmClient (key-less capable via SLOWCOOK_LLM=claude-cli)
 * and vibe's existing XML file-block emit path — including the hard
 * mock/-only write guard.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, normalize } from "node:path";
import { execFileSync } from "node:child_process";
import type { LlmClient } from "@slowcook-ai/core";
import { parseVibeOutput, writeVibeFiles, type VibeFileBlock } from "./emit.js";

export const AS_BUILT_VIBE_SYSTEM = `You are slowcook's as-built vibe agent. You are given the PRODUCTION
source of ONE existing surface. Produce a FAITHFUL, self-contained mock
re-render of it for design review.

Rules, non-negotiable:
- Output ONLY <file path="mock/src/apps/<surface>/...">…</file> blocks. No prose.
- FAITHFUL means: same structure, same copy, same states as the source —
  you are transcribing what IS, not designing. Do not improve, rename,
  restyle or add features. Uncertain behaviour becomes a code comment
  "AS-BUILT-UNCLEAR: …", never an invention.
- Self-contained: react only; no imports from the production tree or any
  package the mock app does not already use. Data the source fetches
  becomes inline fixtures marked "@slowcook-honest: as-built fixture,
  shaped from <source path>".
- The FIRST line of every file must be a comment IN THAT FILE TYPE'S native
  comment syntax (// for ts/tsx, /* … */ for css, <!-- … --> for html):
  @slowcook-as-built-from <source path>@<sha> — prod-first: this mock
  mirrors production; edits here are PROPOSALS, not truth.
- Use the design tokens provided (brand.yaml) via inline styles or the
  mock app's existing CSS variables; do not invent a palette.`;

export interface AsBuiltVibeInput {
  repoRoot: string;
  fromPath: string;
  surface: string;
  sha: string | null;
  sources: { path: string; body: string }[];
  brandYaml: string | null;
}

export function collectAsBuiltInput(repoRoot: string, fromPath: string, surface?: string): AsBuiltVibeInput {
  const norm = normalize(fromPath).replace(/\\/g, "/");
  const abs = join(repoRoot, norm);
  if (!existsSync(abs)) throw new Error(`--from source not found: ${norm}`);
  const main = readFileSync(abs, "utf8");
  const sources: { path: string; body: string }[] = [{ path: norm, body: main }];
  // one hop of same-directory relative imports — the surface's local parts.
  const dir = dirname(norm);
  const rel = [...main.matchAll(/from\s+["']\.\/([\w./-]+)["']/g)].map((m) => m[1]!).slice(0, 6);
  for (const r of rel) {
    for (const ext of ["", ".ts", ".tsx", ".js", ".jsx"]) {
      const p = join(repoRoot, dir, r + ext);
      if (existsSync(p) && !p.endsWith("/")) {
        try {
          sources.push({ path: join(dir, r + ext).replace(/\\/g, "/"), body: readFileSync(p, "utf8").slice(0, 8000) });
        } catch { /* skip */ }
        break;
      }
    }
  }
  let brandYaml: string | null = null;
  try { brandYaml = readFileSync(join(repoRoot, ".brewing/brand.yaml"), "utf8").slice(0, 3000); } catch { /* none */ }
  let sha: string | null = null;
  try { sha = execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); } catch { /* not git */ }
  const surfaceName = surface ?? (norm.split("/").pop() ?? "surface").replace(/\.(tsx?|jsx?)$/, "").replace(/[^a-zA-Z0-9-]/g, "-").toLowerCase();
  return { repoRoot, fromPath: norm, surface: surfaceName, sha, sources, brandYaml };
}

export function buildAsBuiltVibePrompt(input: AsBuiltVibeInput): string {
  const parts: string[] = [];
  parts.push(`Surface name: ${input.surface}`);
  parts.push(`Provenance to stamp: ${input.fromPath}@${input.sha ?? "HEAD"}`);
  parts.push(`Target directory for ALL files: mock/src/apps/${input.surface}/`);
  if (input.brandYaml) parts.push(`===== .brewing/brand.yaml (design tokens) =====\n${input.brandYaml}`);
  for (const s of input.sources) parts.push(`===== PRODUCTION SOURCE: ${s.path} =====\n${s.body}`);
  return parts.join("\n\n");
}

export interface AsBuiltVibeResult { written: string[]; files: VibeFileBlock[]; violations: string[] }

export async function runAsBuiltVibe(
  llm: LlmClient,
  model: string,
  input: AsBuiltVibeInput,
  opts: { dryRun?: boolean } = {},
): Promise<AsBuiltVibeResult> {
  const res = await llm.complete({
    system: AS_BUILT_VIBE_SYSTEM,
    cacheSystem: false,
    model,
    messages: [{ role: "user", content: buildAsBuiltVibePrompt(input) }],
    maxTokens: 12000,
  });
  const out = parseVibeOutput(res.text);
  const violations: string[] = [];
  if (out.files.length === 0) violations.push("model emitted no <file> blocks");
  for (const f of out.files) {
    // stamp must open the file in the file-type's native comment syntax
    // (// for ts/js, /* for css, <!-- for html/md — the landing dogfood's
    // css emission caught the //-only assumption).
    if (!/^(\/\/|\/\*|<!--|#)\s*@slowcook-as-built-from/.test(f.contents)) {
      violations.push(`${f.path}: missing @slowcook-as-built-from provenance stamp on line 1`);
    }
    if (!f.path.startsWith(`mock/src/apps/${input.surface}/`)) {
      violations.push(`${f.path}: outside the surface directory mock/src/apps/${input.surface}/`);
    }
  }
  if (violations.length > 0 || opts.dryRun) return { written: [], files: out.files, violations };
  const written = writeVibeFiles(input.repoRoot, out.files); // hard mock/-only guard inside
  return { written, files: out.files, violations: [] };
}
