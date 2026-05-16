/**
 * `slowcook brand` — design-system foundation agent (sc#82 Phase 4).
 *
 * Runs ONCE per consumer (or on `--refresh`) to populate
 * `mock/src/design-system/{tokens.ts, css.ts}` from a brand brief.
 * Every downstream agent (vibe, plate, brew) inherits the tokens this
 * emits. Without brand, vibe falls back to the neutral seed values
 * `slowcook init mock --shape vite` scaffolds and outputs drift toward
 * shadcn-default styling.
 *
 * Brief sources, in priority order:
 *   1. `--brief "<inline prose>"` flag
 *   2. `.brewing/brand.yaml` file (consumer-authored)
 *   3. CLAUDE.md / README.md (best-effort extraction)
 *
 * Idempotency: refuses to overwrite `mock/src/design-system/tokens.ts`
 * + `css.ts` without `--refresh`. Designed to be safe re-run as the
 * project evolves; PMs explicitly opt-in to brand drift.
 */
import {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
} from "node:fs";
import { dirname, join } from "node:path";
import YAML from "yaml";
import { z } from "zod";
import Anthropic from "@anthropic-ai/sdk";
import { BRAND_SYSTEM, costUsdForUsage } from "@slowcook-ai/llm-anthropic";
import { parseVibeOutput, writeVibeFiles } from "../vibe/emit.js";

const DEFAULT_MODEL = "claude-opus-4-7";
const MAX_TOKENS = 8192;

const BrandConfigSchema = z.object({
  schema_version: z.literal(1),
  name: z.string().min(1),
  description: z.string().min(1),
  /** Free-form palette hint (e.g. "soft teals + warm corals"). */
  palette_hint: z.string().optional(),
  /** Languages the app supports (e.g. ["en", "fa"]). Drives FONTS entries. */
  languages: z.array(z.string()).min(1).default(["en"]),
  /** Optional explicit hex codes (PM nails specific values). */
  colors: z
    .object({
      primary: z.string().regex(/^#[0-9A-Fa-f]{6}$/).optional(),
      accent: z.string().regex(/^#[0-9A-Fa-f]{6}$/).optional(),
    })
    .optional(),
  /** Optional font preferences. */
  fonts_hint: z.string().optional(),
});

export type BrandConfig = z.infer<typeof BrandConfigSchema>;

interface BrandArgs {
  cwd: string;
  refresh: boolean;
  dryRun: boolean;
  briefInline: string | undefined;
  model: string;
}

function parseArgs(argv: string[]): BrandArgs {
  const args: BrandArgs = {
    cwd: process.cwd(),
    refresh: false,
    dryRun: false,
    briefInline: undefined,
    model: DEFAULT_MODEL,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = argv[i + 1];
    if (a === "--cwd" && next) {
      args.cwd = next;
      i++;
    } else if (a === "--refresh") {
      args.refresh = true;
    } else if (a === "--dry-run") {
      args.dryRun = true;
    } else if (a === "--brief" && next) {
      args.briefInline = next;
      i++;
    } else if (a === "--model" && next) {
      args.model = next;
      i++;
    } else if (a === "--help" || a === "-h") {
      printHelp();
      process.exit(0);
    }
  }
  return args;
}

function printHelp(): void {
  console.log(`
slowcook brand — design-system foundation agent (sc#82 Phase 4)

Emits mock/src/design-system/{tokens.ts, css.ts} from a brand brief.
Runs once per project, on demand. Vibe + plate + brew inherit the
tokens this writes.

Usage:
  slowcook brand                                  Read brief from .brewing/brand.yaml + emit (refuses to overwrite without --refresh)
  slowcook brand --brief "<prose>"                Use inline brief instead of brand.yaml
  slowcook brand --refresh                        Overwrite existing design-system files
  slowcook brand --dry-run                        Print planned files without writing
  slowcook brand --cwd <path>                     Project root (default: cwd)
  slowcook brand --model <id>                     Model (default: claude-opus-4-7)

Brief sources, in priority order:
  1. --brief flag (inline)
  2. .brewing/brand.yaml
  3. CLAUDE.md / README.md (best-effort)

Brand.yaml shape:
  schema_version: 1
  name: <project name>
  description: <one-paragraph brief>
  palette_hint: soft teals + warm corals      # optional
  languages: [en, fa]                          # default: [en]
  colors:                                       # optional
    primary: '#3BAFA0'
    accent:  '#E8A07A'
  fonts_hint: Vazirmatn body, Lalezar headings  # optional
`);
}

export function loadBrandConfig(repoRoot: string): BrandConfig | null {
  const p = join(repoRoot, ".brewing", "brand.yaml");
  if (!existsSync(p)) return null;
  const raw = YAML.parse(readFileSync(p, "utf8"));
  const parsed = BrandConfigSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(
      `Invalid .brewing/brand.yaml: ${parsed.error.issues.map((i) => i.message).join("; ")}`,
    );
  }
  return parsed.data;
}

function readBriefFromMarkdown(repoRoot: string): string | null {
  for (const candidate of ["CLAUDE.md", "README.md"]) {
    const p = join(repoRoot, candidate);
    if (existsSync(p)) {
      const body = readFileSync(p, "utf8");
      // Use the first ~2000 characters as best-effort context.
      return body.slice(0, 2000);
    }
  }
  return null;
}

export function buildProjectContext(repoRoot: string, args: BrandArgs): string {
  const sections: string[] = [];
  sections.push("## Brand brief\n");
  if (args.briefInline) {
    sections.push(args.briefInline);
  } else {
    const cfg = loadBrandConfig(repoRoot);
    if (cfg) {
      sections.push(`**Name:** ${cfg.name}\n\n${cfg.description}`);
      if (cfg.palette_hint) sections.push(`\n**Palette hint:** ${cfg.palette_hint}`);
      if (cfg.fonts_hint) sections.push(`**Fonts hint:** ${cfg.fonts_hint}`);
      sections.push(`**Languages:** ${cfg.languages.join(", ")}`);
      if (cfg.colors) {
        const lines: string[] = ["**Explicit colours (use VERBATIM, derive variants):**"];
        if (cfg.colors.primary) lines.push(`- primary: ${cfg.colors.primary}`);
        if (cfg.colors.accent) lines.push(`- accent:  ${cfg.colors.accent}`);
        sections.push(lines.join("\n"));
      }
    } else {
      const md = readBriefFromMarkdown(repoRoot);
      if (md) {
        sections.push("(No `.brewing/brand.yaml`; reading project README/CLAUDE.md as best-effort context.)\n\n");
        sections.push(md);
      } else {
        sections.push("(No brand brief found. Default to a neutral, professional palette.)");
      }
    }
  }
  return sections.join("\n");
}

export async function brand(argv: string[], _cliVersion: string): Promise<void> {
  let args: BrandArgs;
  try {
    args = parseArgs(argv);
  } catch (e) {
    console.error((e as Error).message);
    process.exit(2);
  }

  // Pre-flight: refuse to overwrite without --refresh.
  const tokensPath = join(args.cwd, "mock", "src", "design-system", "tokens.ts");
  const cssPath = join(args.cwd, "mock", "src", "design-system", "css.ts");
  const exists = existsSync(tokensPath) || existsSync(cssPath);
  if (exists && !args.refresh && !args.dryRun) {
    console.error(
      `mock/src/design-system/{tokens.ts,css.ts} already exist. Pass --refresh to overwrite.`,
    );
    process.exit(2);
  }

  const anthropicApiKey = process.env["ANTHROPIC_API_KEY"];
  if (!anthropicApiKey && !args.dryRun) {
    console.error(`ANTHROPIC_API_KEY not set. Either set it or pass --dry-run.`);
    process.exit(2);
  }

  const projectContext = buildProjectContext(args.cwd, args);

  console.log(
    `slowcook brand · cwd: ${args.cwd} (model: ${args.model}${args.dryRun ? ", dry-run" : ""}${args.refresh ? ", refresh" : ""})`,
  );

  if (args.dryRun) {
    console.log("\n--- Project context the agent will receive ---\n");
    console.log(projectContext);
    console.log("\n--dry-run: no LLM call, no files written.");
    return;
  }

  const anthropic = new Anthropic({ apiKey: anthropicApiKey! });
  const userPrompt = `Generate the design-system foundation for this mock app from the brand brief in your system prompt. Emit the two file blocks (\`mock/src/design-system/tokens.ts\` + \`mock/src/design-system/css.ts\`) per the Output format. No prose preamble.`;

  const response = await anthropic.messages.create({
    model: args.model,
    max_tokens: MAX_TOKENS,
    system: BRAND_SYSTEM(projectContext),
    messages: [{ role: "user", content: userPrompt }],
  });

  let spendUsd = 0;
  try {
    // SDK type for usage has narrowed over versions; read via loose cast so
    // newer cache-token fields don't trip strict typecheck.
    const raw = response.usage as unknown as {
      input_tokens: number;
      output_tokens: number;
      cache_read_input_tokens?: number;
      cache_creation_input_tokens?: number;
    };
    spendUsd = costUsdForUsage(args.model, {
      inputTokens: raw.input_tokens,
      outputTokens: raw.output_tokens,
      cacheReadTokens: raw.cache_read_input_tokens ?? 0,
      cacheCreateTokens: raw.cache_creation_input_tokens ?? 0,
    });
  } catch {
    /* cost calc best-effort */
  }

  let finalText = "";
  for (const block of response.content) {
    if (block.type === "text") finalText = block.text;
  }

  const parsed = parseVibeOutput(finalText);
  if (parsed.files.length === 0) {
    console.error(
      `Brand agent emitted no <file> blocks. Spend: $${spendUsd.toFixed(4)}.`,
    );
    if (process.env["SLOWCOOK_DEBUG"]) {
      console.error("\n--- agent's final text ---\n");
      console.error(finalText);
    }
    process.exit(2);
  }

  // Validate paths: every file must be under mock/src/design-system/
  for (const f of parsed.files) {
    if (!f.path.startsWith("mock/src/design-system/")) {
      console.error(
        `Brand emit refused: file outside mock/src/design-system/: ${f.path}. Run with --dry-run to see what the agent wanted to write.`,
      );
      process.exit(2);
    }
  }

  // Write — writeVibeFiles enforces the mock/ root constraint.
  const written = writeVibeFiles(args.cwd, parsed.files);
  for (const p of written) {
    console.log(`  write  ${p}`);
  }

  console.log(`\nDone. Spend: $${spendUsd.toFixed(4)}.`);
  console.log(`Next: \`slowcook vibe --spec <id>\` — vibe will read your new design-system on the next dispatch.`);
}
