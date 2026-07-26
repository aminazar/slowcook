/**
 * `slowcook vibe journeys` — compile the journeys artifact (storyteller P1).
 *
 * Two paths to `.brewing/journeys.yaml`:
 *  - DETERMINISTIC: a concept.yaml exists (the rigorous route's standing
 *    artifact). Its journeys compile 1:1; whatever the concept does NOT
 *    carry (persona binding, screen routes, per-step affordances/actions/
 *    acceptance expects) is reported as machine-executability GAPS and
 *    filed as backprop claims against the concept — the practice's first
 *    backprop moment, by design.
 *  - SYNTHESIS: no concept.yaml (pure-spec repos). The LLM chains the
 *    specs' personas + acceptance scenarios into ordered journeys; output
 *    is schema-validated with one format retry.
 *
 * The artifact is the walkers' contract: `vibe tell` executes it, `vibe
 * check` replays it. Steps act on `data-affordance` ids, never selectors.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { JourneysFileSchema, listWalks, type Journey, type JourneysFile, type JourneyStep } from "./journeys-schema.js";
import { fileBackpropClaims, type BackpropClaim } from "../../lib/backprop.js";

const argFlag = (argv: string[], flag: string): string | undefined => {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
};

/* ────────────────────────────── concept.yaml input shape (loose) */

interface ConceptJourney {
  id: string;
  rank?: number;
  persona?: string;
  story?: string;
  epic?: string;
  start_world?: string;
  steps?: {
    text?: string;
    screen?: string;
    affordance?: string;
    action?: string;
    input?: string;
    destructive?: boolean;
    expect?: { kind: string; expr: string; world_sensitive?: boolean }[];
    branches?: { id: string; given: string; steps: ConceptJourney["steps"] }[];
  }[];
}

interface ConceptDoc {
  journeys?: ConceptJourney[];
  screens?: { id: string; route?: string; overlay?: boolean }[];
  personas?: { id: string }[];
}

export function findConceptYaml(cwd: string, explicit?: string): string | null {
  const candidates = explicit
    ? [resolve(cwd, explicit)]
    : [resolve(cwd, ".brewing/concept/concept.yaml"), resolve(cwd, "concept/concept.yaml")];
  for (const c of candidates) if (existsSync(c)) return c;
  return null;
}

export interface CompileResult {
  file: JourneysFile;
  /** Machine-executability gaps — each becomes a backprop claim. */
  gaps: BackpropClaim[];
  /** journeys × walks counted, for the console report. */
  stats: { journeys: number; walks: number; steps: number; executableSteps: number };
}

/** Deterministic compile: concept journeys → journeys.yaml + gap claims. */
export function compileFromConcept(doc: ConceptDoc, conceptRef: string): CompileResult {
  const gaps: BackpropClaim[] = [];
  const routeOf = new Map<string, string>();
  for (const s of doc.screens ?? []) if (s.route) routeOf.set(s.id, s.route);

  const claim = (summary: string, detail: string) =>
    gaps.push({ target: "concept", summary, detail, source: conceptRef });

  const journeys: Journey[] = [];
  let steps = 0;
  let executable = 0;

  for (const cj of doc.journeys ?? []) {
    if (!cj.steps?.length) continue;
    const persona = cj.persona ?? "";
    if (!persona) claim(`journey "${cj.id}" has no persona`, "Add `persona:` — the storyteller walks AS someone; a journey without an actor cannot be told.");

    const mapSteps = (src: NonNullable<ConceptJourney["steps"]>, prefix: string): JourneyStep[] =>
      src.map((cs, i) => {
        steps++;
        const id = `${prefix}s${i + 1}`;
        const screen = cs.screen ?? "";
        const route = screen ? routeOf.get(screen) : undefined;
        if (screen && !route) claim(`screen "${screen}" has no route`, `Journey "${cj.id}" step ${i + 1} targets screen "${screen}" but the concept's screen card carries no \`route:\` — the walker cannot navigate to it.`);
        const action = (cs.action as JourneyStep["action"]) ?? "goto";
        const hasAffordance = !!cs.affordance;
        if (action !== "goto" && !hasAffordance) {
          claim(`step "${cj.id}/${id}" has an action but no affordance`, `Action "${action}" needs an \`affordance:\` id (the data-affordance the builder must render).`);
        }
        if (action === "goto" && !cs.action && (cs.text ?? "").match(/\b(click|press|tap|select|choose|open|submit|save|create|add|remove|delete|confirm|send|upload|approve)\b/i)) {
          claim(`step "${cj.id}/${id}" reads like an interaction but is compiled as goto`, `Step text: "${cs.text}". Add \`action:\` + \`affordance:\` (+ \`expect:\` from its acceptance scenario) to make it machine-executable.`);
        }
        if (action !== "goto" && (cs.expect ?? []).length === 0) {
          claim(`step "${cj.id}/${id}" has no acceptance expects`, `Interactions must assert the acceptance's Then against the adaptor (law 5) — add \`expect:\` entries.`);
        } else if (action !== "goto") {
          executable++;
        }
        return {
          id,
          text: cs.text ?? "",
          route: route ?? "/",
          action,
          ...(cs.affordance ? { affordance: cs.affordance } : {}),
          ...(cs.input ? { input: cs.input } : {}),
          ...(cs.destructive ? { destructive: true } : {}),
          expect: (cs.expect ?? []).map((e) => ({ kind: e.kind as "query" | "dom", expr: e.expr, ...(e.world_sensitive !== undefined ? { world_sensitive: e.world_sensitive } : {}) })),
          ...(cs.branches?.length
            ? { branches: cs.branches.map((b) => ({ id: b.id, given: b.given, steps: mapSteps(b.steps ?? [], `${b.id}-`) })) }
            : {}),
        };
      });

    journeys.push({
      id: cj.id,
      epic: cj.epic ?? cj.id,
      persona: persona || "unknown",
      title: cj.story ?? cj.id,
      start_world: cj.start_world ?? "empty",
      red_route_rank: Math.min(Math.max(cj.rank ?? 4, 1), 4),
      source: { kind: "concept", ref: `${conceptRef}#journeys/${cj.id}` },
      steps: mapSteps(cj.steps, ""),
    });
  }

  const file: JourneysFile = { schema_version: 1, journeys };
  const walks = journeys.reduce((n, j) => n + listWalks(j).length, 0);
  return { file, gaps, stats: { journeys: journeys.length, walks, steps, executableSteps: executable } };
}

/* ────────────────────────────── command */

export async function runJourneys(argv: string[]): Promise<void> {
  const cwd = resolve(argFlag(argv, "--cwd") ?? ".");
  const dryRun = argv.includes("--dry-run");
  const noClaims = argv.includes("--no-claims");
  const outPath = resolve(cwd, argFlag(argv, "--out") ?? ".brewing/journeys.yaml");

  const conceptPath = findConceptYaml(cwd, argFlag(argv, "--concept"));

  if (!conceptPath) {
    // Synthesis path (spec-only repos): print the prompt in dry-run; call the
    // LLM otherwise. Kept minimal in P1 — schema-validated with one retry.
    const { synthesizeJourneys } = await import("./journeys-synth.js");
    return synthesizeJourneys({ cwd, outPath, dryRun, model: argFlag(argv, "--model") });
  }

  const doc = parseYaml(readFileSync(conceptPath, "utf8")) as ConceptDoc;
  const { file, gaps, stats } = compileFromConcept(doc, conceptPath.replace(cwd + "/", ""));

  const parsed = JourneysFileSchema.safeParse(file);
  if (!parsed.success) {
    console.error("vibe journeys: compiled artifact failed schema validation:");
    for (const issue of parsed.error.issues.slice(0, 10)) console.error(`  ${issue.path.join(".")}: ${issue.message}`);
    process.exit(1);
  }

  if (dryRun) {
    console.log(`vibe journeys [dry-run] — ${stats.journeys} journeys · ${stats.walks} walks · ${stats.steps} steps (${stats.executableSteps} fully executable)`);
    for (const g of gaps) console.log(`  gap → ${g.summary}`);
    return;
  }

  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, stringifyYaml(parsed.data));
  console.log(`vibe journeys — wrote ${outPath.replace(cwd + "/", "")}`);
  console.log(`  ${stats.journeys} journeys · ${stats.walks} walks · ${stats.steps} steps · ${stats.executableSteps} fully executable`);

  if (gaps.length > 0) {
    console.log(`  ${gaps.length} machine-executability gap(s) — the concept owes the walker answers:`);
    for (const g of gaps.slice(0, 12)) console.log(`    · ${g.summary}`);
    if (gaps.length > 12) console.log(`    · … and ${gaps.length - 12} more`);
    if (!noClaims) {
      const filed = await fileBackpropClaims(cwd, gaps);
      console.log(`  backprop: ${filed.mirrored} claim(s) recorded${filed.issued > 0 ? `, ${filed.issued} filed as issues` : " (no forge configured — mirror only)"}`);
    }
  }
}
