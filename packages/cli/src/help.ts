/**
 * `packages/cli/src/help.ts` — render the command manifest into the
 * two surfaces consumers see:
 *
 *  1. `slowcook help` — plain-text terminal output (what `cli.ts` emits)
 *  2. README catalog block — markdown spliced into packages/cli/README.md
 *
 * Both come from `COMMANDS` in `./commands.manifest.ts`. Adding a
 * command in one place updates both surfaces.
 */

import type { CommandEntry, CommandGroup } from "./commands.manifest.js";
import { visibleCommands, findCommand } from "./commands.manifest.js";

const GROUP_ORDER: CommandGroup[] = [
  "pipeline",
  "checks",
  "plumbing",
  "knowledge",
  "ops",
  "experimental",
];

const GROUP_LABELS: Record<CommandGroup, string> = {
  pipeline:     "Pipeline (agent-driven)",
  checks:       "Checks + guards",
  plumbing:     "Setup + lifecycle plumbing",
  knowledge:    "Knowledge + accounting",
  ops:          "Ops (preview, dev-env, etc.)",
  experimental: "Experimental",
};

function statusBadge(status: CommandEntry["status"]): string {
  switch (status) {
    case "alpha":        return " [alpha]";
    case "experimental": return " [experimental]";
    case "deprecated":   return " [DEPRECATED]";
    case "stable":
    case undefined:
    default:             return "";
  }
}

function groupBy(cmds: CommandEntry[]): Record<CommandGroup, CommandEntry[]> {
  const out: Record<CommandGroup, CommandEntry[]> = {
    pipeline: [], checks: [], plumbing: [], knowledge: [], ops: [], experimental: [],
  };
  for (const c of cmds) out[c.group].push(c);
  return out;
}

/**
 * Plain-text help block for `slowcook help`.
 *
 * Format (preserves the existing 0.19 shape — backward compat with any
 * tool that greps `slowcook help` output):
 *
 *   slowcook — TDD-first agentic development harness
 *
 *   Usage:
 *     <usage lines>
 *
 *   Commands available in <version>:
 *     <name>  <description>
 *
 *   Docs: https://github.com/aminazar/slowcook
 */
export function renderHelp(version: string): string {
  const cmds = visibleCommands();
  const usageLines = cmds.map((c) => `  ${c.usage}`).join("\n");

  // Description block: align names in a column. Longest visible name width.
  const nameWidth = Math.max(...cmds.map((c) => c.name.length)) + 2;
  const descLines = cmds
    .map((c) => `  ${c.name.padEnd(nameWidth)}${c.description}${statusBadge(c.status)}`)
    .join("\n");

  return `
slowcook — TDD-first agentic development harness

Usage:
${usageLines}

Commands available in ${version}:
${descLines}

For per-command details: slowcook help <command>   or   slowcook <command> --help

Docs: https://github.com/aminazar/slowcook
`;
}

/**
 * Per-command help (shown by `slowcook help <cmd>` or future
 * standardized `slowcook <cmd> --help` shims). Returns `undefined`
 * if the name is unknown so the caller can decide on the fallback.
 */
export function renderCommandHelp(nameOrAlias: string): string | undefined {
  const cmd = findCommand(nameOrAlias);
  if (!cmd) return undefined;
  const aliases = cmd.aliases?.length ? `\nAliases: ${cmd.aliases.join(", ")}` : "";
  return `
slowcook ${cmd.name}${statusBadge(cmd.status)}

${cmd.description}

Usage:
  ${cmd.usage}${aliases}

Group: ${GROUP_LABELS[cmd.group]}
`;
}

/**
 * Markdown catalog block spliced into packages/cli/README.md between
 * `<!-- COMMANDS BLOCK BEGIN -->` and `<!-- COMMANDS BLOCK END -->` by
 * `scripts/sync-readme-help.sh`.
 *
 * Grouped by `CommandGroup`; one bullet per command with name + usage
 * + description. Hidden commands (version, help) excluded.
 */
export function renderReadmeBlock(): string {
  const grouped = groupBy(visibleCommands());
  const sections: string[] = [];
  for (const g of GROUP_ORDER) {
    const entries = grouped[g];
    if (entries.length === 0) continue;
    sections.push(`### ${GROUP_LABELS[g]}\n`);
    for (const c of entries) {
      sections.push(`- **\`${c.name}\`**${statusBadge(c.status)} — ${c.description}`);
      sections.push(`  \`\`\``);
      sections.push(`  ${c.usage}`);
      sections.push(`  \`\`\``);
    }
    sections.push("");
  }
  return sections.join("\n");
}
