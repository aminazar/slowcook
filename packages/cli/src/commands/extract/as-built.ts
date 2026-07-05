/**
 * `slowcook extract --as-built` — tier 1 of #262: the LLM pass that turns an
 * existing repo into `.brewing/as-built.md`: what the product IS, as observed,
 * every statement citing its source. Section contract mirrors the hand-made
 * originals (dash's brownfield intake ingests these sections directly):
 *
 *   ## What the product is
 *   ## Map
 *   ## Data model (as-built)
 *   ## Honesty notes            (docs-vs-code lies, stubs, dead features)
 *   ## Founder questions (intake queue)
 *
 * CITATION DISCIPLINE is enforced deterministically after generation: every
 * bullet outside the questions section must carry a `(path[:line…])` citation;
 * violations are reported and the run fails without --allow-uncited. This is
 * verify-before-spec's foundation — an uncited claim is a guess.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { LlmClient } from "@slowcook-ai/core";
import type { SurveyOutput } from "./survey.js";

export const AS_BUILT_SYSTEM = `You are slowcook's brownfield extraction agent. You produce AS-BUILT
documentation of an EXISTING product from its repository: what IS, as
observed in the code — never what docs promise, never invented intent.

Rules, non-negotiable:
- Output ONLY the markdown document, no preamble.
- Structure EXACTLY: a single "# <repo name> — as-built" title line, then the
  sections "## What the product is", "## Map", "## Data model (as-built)",
  "## Honesty notes", "## Founder questions (intake queue)".
- Every bullet in every section EXCEPT the questions section MUST end with a
  citation in parentheses naming the file(s) it was observed in, e.g.
  (src/lib/emotions/index.ts:1-14) or (supabase/migrations/00013.sql). No
  citation = the bullet will be rejected by a validator.
- When repo documents CONTRADICT the code, the code is truth: state the code's
  behaviour and flag the contradiction in "Honesty notes" citing both sides.
- "Founder questions" = numbered questions only a human can answer (unclear
  intent, missing infra facts, dead features to rule on). No citations needed.
- Be dense and specific. 40-70 bullets total. Never pad, never speculate —
  what you cannot see, you either omit or turn into a founder question.`;

export interface Dossier { userPrompt: string; filesIncluded: string[] }

const KEY_DOC = /^(readme|claude)\.md$/i;
const INTERESTING = [
  /^docs\/[^/]+\.md$/i,
  /^(package|pnpm-workspace|foundry|cargo|go)\.(json|yaml|toml|mod)$/i,
  /migrations?\/[^/]+\.(sql|ts|js)$/i,
  /schema[^/]*\.(ts|sql|prisma)$/i,
];
const ROUTEISH = /(app|pages|routes|src\/app)\/.*\.(tsx?|jsx?|vue|svelte)$/i;

/** assemble the model's evidence pack: survey + key files (truncated) + route inventory. */
export function buildDossier(repoRoot: string, survey: SurveyOutput, allPaths: string[]): Dossier {
  const parts: string[] = [];
  const included: string[] = [];
  parts.push(`# Deterministic survey (tier 0)\n${JSON.stringify({ repo_head: survey.repo_head, claims: survey.claims.map((c) => c.statement), skipped: survey.skipped }, null, 1)}`);

  const read = (p: string, cap: number): void => {
    try {
      const body = readFileSync(join(repoRoot, p), "utf8");
      included.push(p);
      parts.push(`\n===== FILE: ${p} =====\n${body.slice(0, cap)}${body.length > cap ? "\n…(truncated)" : ""}`);
    } catch { /* unreadable */ }
  };

  for (const p of allPaths) if (KEY_DOC.test(p)) read(p, 6000);
  for (const p of allPaths.filter((p) => INTERESTING.some((re) => re.test(p))).sort().slice(0, 25)) read(p, 4000);

  const routes = allPaths.filter((p) => ROUTEISH.test(p) && !/test|spec|stories/.test(p)).sort().slice(0, 120);
  parts.push(`\n===== ROUTE/SURFACE FILE INVENTORY (${routes.length}) =====\n${routes.join("\n")}`);
  // a few route files in full — the product's actual behaviour lives here.
  for (const p of routes.filter((p) => /route\.|page\.|index\./i.test(p)).slice(0, 8)) read(p, 3000);

  return { userPrompt: parts.join("\n"), filesIncluded: included };
}

export interface CitationReport { bullets: number; uncited: string[] }

/** deterministic post-check: bullets outside the questions section need (path…) citations. */
export function validateCitations(md: string): CitationReport {
  const lines = md.split("\n");
  let inQuestions = false;
  let bullets = 0;
  const uncited: string[] = [];
  for (const l of lines) {
    if (/^##\s/.test(l)) inQuestions = /founder questions/i.test(l);
    if (inQuestions) continue;
    const t = l.trim();
    if (!/^[-*]\s/.test(t)) continue;
    bullets++;
    // a citation is a paren group naming a path or file — allowing ONE level
    // of nested parens because real paths contain them (Next.js route groups
    // like src/app/(landing)/page.tsx — found by the rewo dogfood).
    const groups = t.match(/\((?:[^()]|\([^()]*\))*\)/g) ?? [];
    const cited = groups.some((g) => /[\w)\].-]\/[\w(.-]/.test(g) || /\.(ts|tsx|js|jsx|sql|md|mdx|ya?ml|toml|json|sol|py|go|rs|css|prisma)\b/.test(g));
    if (!cited) uncited.push(t.slice(0, 110));
  }
  return { bullets, uncited };
}

const REQUIRED_SECTIONS = ["## What the product is", "## Map", "## Data model (as-built)", "## Honesty notes", "## Founder questions (intake queue)"];

export function validateSections(md: string): string[] {
  return REQUIRED_SECTIONS.filter((s) => !md.includes(s));
}

export async function generateAsBuilt(
  llm: LlmClient,
  model: string,
  dossier: Dossier,
): Promise<{ md: string; usage: unknown }> {
  const res = await llm.complete({
    system: AS_BUILT_SYSTEM,
    cacheSystem: false,
    model,
    messages: [{ role: "user", content: dossier.userPrompt }],
    maxTokens: 16000,
  });
  // strip accidental fences
  const md = res.text.replace(/^```(?:markdown|md)?\n/, "").replace(/\n```\s*$/, "").trim() + "\n";
  return { md, usage: (res as { usage?: unknown }).usage };
}
