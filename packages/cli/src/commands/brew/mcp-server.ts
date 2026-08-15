/**
 * SLOWCOOK MCP SERVER — brew's tool surface over stdio (#393, handover §1A).
 *
 * Why this exists: brew on the Anthropic API meters every token; the local
 * `claude` CLI runs on SUBSCRIPTION auth, but it can only reach brew's tools
 * through MCP. This file is that bridge: a deliberately minimal MCP stdio
 * server (hand-rolled JSON-RPC — no SDK dependency) exposing the same nine
 * tools BREW_TOOLS declares to the API, with the same path guards.
 *
 * It runs as a SUBPROCESS (claude spawns it from --mcp-config), so it cannot
 * share brew's in-process state. That is fine by construction:
 *   - the ratchet measures edits with git diff, not write_file interception;
 *   - the tool-call TRACE and any justify_diff_overflow land in side files
 *     under the run dir, which brew reads when the CLI session ends.
 *
 * Spawn: node mcp-server.js --repo <abs repoRoot> --run <abs runDir>
 */
import { readFileSync, writeFileSync, appendFileSync, existsSync, statSync, readdirSync } from "node:fs";
import { resolve, join, relative, isAbsolute } from "node:path";

const argv = process.argv.slice(2);
const arg = (name: string): string => {
  const i = argv.indexOf(name);
  if (i === -1 || !argv[i + 1]) throw new Error(`missing ${name}`);
  return argv[i + 1]!;
};
const REPO = resolve(arg("--repo"));
const RUN = resolve(arg("--run"));
const TRACE = join(RUN, "mcp-tool-trace.jsonl");
const OVERFLOW = join(RUN, "mcp-overflow-justification.json");

/** Same discipline as brew's resolveRepoPath: stay inside the repo, except
 *  the sibling-acceptance read path (`../…`) which is READ-ONLY. */
function resolvePath(p: string, forWrite: boolean): string {
  const full = isAbsolute(p) ? p : resolve(REPO, p);
  const rel = relative(REPO, full);
  const outside = rel.startsWith("..");
  if (forWrite && outside) {
    // one exception, mirrored from the dogfood layout: sibling acceptance
    // arm dir is writable (the deployer the suite loads).
    if (!/acceptance\/src\/arm\//.test(full)) throw new Error(`write outside repo refused: ${p}`);
  }
  return full;
}

function trace(name: string, input: Record<string, unknown>): void {
  const summary = String(input["path"] ?? input["symbol"] ?? input["reason_category"] ?? "");
  appendFileSync(TRACE, JSON.stringify({ at: Date.now(), name, summary }) + "\n");
}

type ToolResult = { content: string; is_error?: boolean };

function outline(src: string): string {
  return src.split("\n").map((l, i) => ({ l, i }))
    .filter(({ l }) => /^(export |function |class |interface |const [A-Z]|contract |library |struct |enum |\s{0,4}function )/.test(l))
    .map(({ l, i }) => `${i + 1}: ${l.trim().slice(0, 120)}`).join("\n") || "(no outline-able declarations)";
}

function walk(dir: string, out: string[] = [], depth = 0): string[] {
  if (depth > 6 || out.length > 4000) return out;
  for (const n of readdirSync(dir)) {
    if (n === "node_modules" || n === ".git" || n === "cache" || n === "out") continue;
    const p = join(dir, n);
    try {
      if (statSync(p).isDirectory()) walk(p, out, depth + 1);
      else out.push(p);
    } catch { /* races are fine */ }
  }
  return out;
}

function grepRepo(pattern: string): string {
  const rx = new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const hits: string[] = [];
  for (const f of walk(REPO)) {
    if (!/\.(sol|ts|tsx|js|json|toml|md)$/.test(f)) continue;
    try {
      const lines = readFileSync(f, "utf8").split("\n");
      lines.forEach((l, i) => { if (hits.length < 60 && rx.test(l)) hits.push(`${relative(REPO, f)}:${i + 1}: ${l.trim().slice(0, 160)}`); });
    } catch { /* unreadable */ }
  }
  return hits.join("\n") || `(no references to ${pattern})`;
}

function handle(name: string, input: Record<string, unknown>): ToolResult {
  try {
    switch (name) {
      case "read_file": {
        const full = resolvePath(String(input["path"] ?? ""), false);
        if (!existsSync(full) || !statSync(full).isFile()) return { content: `File not found: ${input["path"]}`, is_error: true };
        const txt = readFileSync(full, "utf8");
        return { content: txt.length > 20000 ? txt.slice(0, 20000) + "\n…(truncated)" : txt };
      }
      case "outline_file": {
        const full = resolvePath(String(input["path"] ?? ""), false);
        if (!existsSync(full)) return { content: `File not found: ${input["path"]}`, is_error: true };
        return { content: outline(readFileSync(full, "utf8")) };
      }
      case "list_directory": {
        const full = resolvePath(String(input["path"] ?? "."), false);
        if (!existsSync(full)) return { content: `Not found: ${input["path"]}`, is_error: true };
        return { content: readdirSync(full).slice(0, 300).join("\n") };
      }
      case "write_file": {
        const full = resolvePath(String(input["path"] ?? ""), true);
        writeFileSync(full, String(input["content"] ?? ""), "utf8");
        return { content: `wrote ${input["path"]}` };
      }
      case "find_references": case "find_implementations": case "find_definition":
        return { content: grepRepo(String(input["symbol"] ?? "")) };
      case "find_handler":
        return { content: grepRepo(`${input["method"] ?? ""} ${input["path"] ?? ""}`.trim()) };
      case "justify_diff_overflow": {
        writeFileSync(OVERFLOW, JSON.stringify(input), "utf8");
        return { content: "justification recorded — proceed with the large diff this turn" };
      }
      default:
        return { content: `unknown tool ${name}`, is_error: true };
    }
  } catch (e) {
    return { content: (e as Error).message, is_error: true };
  }
}

// ---- minimal MCP over stdio (JSON-RPC 2.0, newline-delimited) ----
let toolSchemas: { name: string; description?: string; inputSchema: unknown }[] = [];
try {
  // Schemas ride in a file the driver writes, so this server never imports
  // llm-anthropic (keeps the subprocess dependency-free and start-fast).
  toolSchemas = JSON.parse(readFileSync(join(RUN, "mcp-tools.json"), "utf8"));
} catch { toolSchemas = []; }

let buf = "";
process.stdin.on("data", (chunk: Buffer) => {
  buf += chunk.toString("utf8");
  let nl: number;
  while ((nl = buf.indexOf("\n")) !== -1) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    let msg: { id?: number | string; method?: string; params?: Record<string, unknown> };
    try { msg = JSON.parse(line); } catch { continue; }
    const reply = (result: unknown) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }) + "\n");
    switch (msg.method) {
      case "initialize":
        reply({ protocolVersion: (msg.params?.["protocolVersion"] as string) ?? "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "slowcook", version: "1" } });
        break;
      case "notifications/initialized": break; // notification, no reply
      case "tools/list":
        reply({ tools: toolSchemas.map((t) => ({ name: t.name, description: t.description ?? "", inputSchema: t.inputSchema })) });
        break;
      case "tools/call": {
        const name = String(msg.params?.["name"] ?? "");
        const args = (msg.params?.["arguments"] ?? {}) as Record<string, unknown>;
        trace(name, args);
        const r = handle(name, args);
        reply({ content: [{ type: "text", text: r.content }], isError: r.is_error === true });
        break;
      }
      case "ping": reply({}); break;
      default:
        if (msg.id !== undefined) reply({});
    }
  }
});
process.stdin.on("end", () => process.exit(0));
