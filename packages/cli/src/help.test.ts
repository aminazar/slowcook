import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { COMMANDS, visibleCommands, findCommand } from "./commands.manifest.js";
import { renderHelp, renderCommandHelp, renderReadmeBlock } from "./help.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI_SOURCE = readFileSync(join(__dirname, "cli.ts"), "utf8");

describe("commands manifest", () => {
  it("every command name is unique (aliases included)", () => {
    const seen = new Set<string>();
    const dupes: string[] = [];
    for (const c of COMMANDS) {
      if (seen.has(c.name)) dupes.push(c.name);
      seen.add(c.name);
      for (const a of c.aliases ?? []) {
        if (seen.has(a)) dupes.push(a);
        seen.add(a);
      }
    }
    expect(dupes).toEqual([]);
  });

  it("every command has a non-empty usage + description", () => {
    for (const c of COMMANDS) {
      expect(c.usage.length, c.name).toBeGreaterThan(0);
      expect(c.description.length, c.name).toBeGreaterThan(0);
    }
  });

  it("usage always starts with `slowcook <name>`", () => {
    for (const c of COMMANDS) {
      expect(c.usage.startsWith(`slowcook ${c.name}`), `${c.name}: ${c.usage}`).toBe(true);
    }
  });

  it("findCommand resolves both names and aliases", () => {
    expect(findCommand("recipe")?.name).toBe("recipe");
    expect(findCommand("testgen")?.name).toBe("recipe"); // alias
    expect(findCommand("does-not-exist")).toBeUndefined();
  });

  it("every entry in cli.ts switch has a matching manifest entry", () => {
    // Pull all `case "<name>":` literals from the cli.ts switch statement
    // (anywhere they appear). Exclude flag-style cases (--help, -h, -v, --version, --markdown-readme).
    const caseRe = /case\s+"([a-z][a-z0-9-]*)"\s*:/g;
    const cases = new Set<string>();
    for (const m of CLI_SOURCE.matchAll(caseRe)) {
      const name = m[1];
      if (!name) continue;
      // Subcommand cases inside `knowledge` (add), `cost` (log), `stories` (status) etc.
      // are NOT top-level commands — skip them.
      const subcommandTokens = new Set(["add", "log", "status", "show", "set", "rm",
        "record", "verify", "generate", "check", "push", "switch", "up", "sync", "reset",
        "deploy", "teardown", "mock-isolation", "spec", "all", "list",
        "fixture", "fixtures-dir", "story", "monthly", "start-day", "json", "session",
        "help",
      ]);
      if (subcommandTokens.has(name)) continue;
      cases.add(name);
    }
    const known = new Set<string>(COMMANDS.flatMap((c) => [c.name, ...(c.aliases ?? [])]));
    const missing: string[] = [];
    for (const c of cases) {
      if (!known.has(c)) missing.push(c);
    }
    expect(missing).toEqual([]);
  });
});

describe("renderHelp", () => {
  it("renders the version + every visible command", () => {
    const out = renderHelp("0.19.5");
    expect(out).toContain("Commands available in 0.19.5:");
    for (const c of visibleCommands()) {
      expect(out, c.name).toContain(c.name);
    }
  });

  it("hides commands marked hidden", () => {
    const out = renderHelp("0.19.5");
    // `version` + `help` are hidden in the manifest. They still appear as
    // command tokens in some descriptions (e.g. `slowcook help`), so this
    // checks the Usage block specifically.
    const usageBlock = out.split("Commands available in")[0]!;
    expect(usageBlock).not.toContain("  slowcook version");
    expect(usageBlock).not.toContain("  slowcook help");
  });

  it("includes the docs URL", () => {
    expect(renderHelp("0.19.5")).toContain("https://github.com/aminazar/slowcook");
  });
});

describe("renderCommandHelp", () => {
  it("returns per-command usage for known names", () => {
    const out = renderCommandHelp("brew");
    expect(out).toBeDefined();
    expect(out!).toContain("slowcook brew");
    expect(out!).toContain("Usage:");
  });

  it("resolves aliases", () => {
    const out = renderCommandHelp("testgen");
    expect(out).toBeDefined();
    expect(out!).toContain("slowcook recipe");
    expect(out!).toContain("Aliases: testgen");
  });

  it("returns undefined for unknown commands", () => {
    expect(renderCommandHelp("does-not-exist")).toBeUndefined();
  });
});

describe("renderReadmeBlock", () => {
  it("emits markdown with one bullet per visible command", () => {
    const out = renderReadmeBlock();
    for (const c of visibleCommands()) {
      expect(out, c.name).toContain(`\`${c.name}\``);
      expect(out, `usage for ${c.name}`).toContain(c.usage);
    }
  });

  it("groups commands by section heading", () => {
    const out = renderReadmeBlock();
    expect(out).toContain("### Pipeline (agent-driven)");
    expect(out).toContain("### Setup + lifecycle plumbing");
  });

  it("badges alpha + experimental commands", () => {
    const out = renderReadmeBlock();
    // `stories` is alpha in 0.19.5
    expect(out).toContain("`stories`");
    expect(out).toMatch(/`stories`[^\n]*\[alpha\]/);
  });
});
