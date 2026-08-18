/**
 * Solidity code map.
 *
 * `slowcook map generate` was Next.js-shaped — routes, pages, components,
 * helpers, types — so on a Foundry repo it emitted zero entries and brew
 * warned "code-map.json is EMPTY … re-run `slowcook map generate`", advice
 * that could not possibly help. Meanwhile iteration 1 of a real Solidity brew
 * spent $2.11 doing nothing but `list_directory` and `read_file` to discover
 * a repo the map should have handed it.
 *
 * The entities that matter here are not routes and components. They are
 * contracts, what they inherit, and the externally reachable surface an agent
 * has to satisfy: functions with visibility/mutability, events, custom errors,
 * and modifiers.
 *
 * Dependency-free by design (this package's only dep is @slowcook-ai/core):
 * pulling a Solidity parser to list declarations would be a large dependency
 * for a shallow need. The trade-off is honest — this reads DECLARATIONS, not
 * semantics. It does not resolve imports, inherited members, or types. It is
 * a map, not a compiler.
 */

export type ContractKind = "contract" | "abstract contract" | "interface" | "library";

export interface SolFunctionEntry {
  name: string;
  /** external | public | internal | private; "" when unstated. */
  visibility: string;
  /** view | pure | payable; "" when non-payable state-changing. */
  mutability: string;
  /** 1-based declaration line. */
  line: number;
}

export interface ContractEntry {
  name: string;
  kind: ContractKind;
  file: string;
  /** 1-based declaration line. */
  line: number;
  /** Base contracts from the `is A, B` clause, in source order. */
  inherits: string[];
  functions: SolFunctionEntry[];
  events: string[];
  errors: string[];
  modifiers: string[];
  /** Leading natspec on the declaration (slash-slash-slash or block), one line. */
  natspec?: string;
}

/**
 * Blank out comments and string/hex literals, PRESERVING length and newlines,
 * so byte offsets still map to the original line numbers.
 *
 * This is the correctness core: without it, `// contract Foo` inside a comment
 * and "contract" inside a revert string both register as declarations.
 */
export function blankNonCode(src: string): string {
  const out = src.split("");
  let i = 0;
  const n = src.length;
  const blank = (from: number, to: number): void => {
    for (let k = from; k < to && k < n; k++) if (out[k] !== "\n") out[k] = " ";
  };
  while (i < n) {
    const c = src[i];
    const d = src[i + 1];
    if (c === "/" && d === "/") {
      let j = i + 2;
      while (j < n && src[j] !== "\n") j++;
      blank(i, j);
      i = j;
    } else if (c === "/" && d === "*") {
      let j = i + 2;
      while (j < n && !(src[j] === "*" && src[j + 1] === "/")) j++;
      blank(i, Math.min(j + 2, n));
      i = j + 2;
    } else if (c === '"' || c === "'") {
      const quote = c;
      let j = i + 1;
      while (j < n && src[j] !== quote) {
        if (src[j] === "\\") j++;
        j++;
      }
      blank(i, Math.min(j + 1, n));
      i = j + 1;
    } else {
      i++;
    }
  }
  return out.join("");
}

/** Byte offset -> 1-based line. */
function lineIndex(src: string): (offset: number) => number {
  const starts: number[] = [0];
  for (let i = 0; i < src.length; i++) if (src[i] === "\n") starts.push(i + 1);
  return (offset: number) => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid]! <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };
}

/** Index of the `}` closing the `{` at openIdx, or the end of source. */
function matchBrace(code: string, openIdx: number): number {
  let depth = 0;
  for (let i = openIdx; i < code.length; i++) {
    if (code[i] === "{") depth++;
    else if (code[i] === "}") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return code.length;
}

const VISIBILITY = ["external", "public", "internal", "private"];
const MUTABILITY = ["view", "pure", "payable"];

/** Natspec immediately above a declaration, flattened to one line. */
function natspecAbove(original: string, declOffset: number): string | undefined {
  const before = original.slice(0, declOffset);
  const lines = before.split("\n");
  lines.pop(); // partial line holding the declaration
  const collected: string[] = [];
  for (let i = lines.length - 1; i >= 0; i--) {
    const t = lines[i]!.trim();
    if (t === "") { if (collected.length) break; continue; }
    if (t.startsWith("///")) { collected.unshift(t.replace(/^\/+/, "").trim()); continue; }
    if (t.startsWith("*") || t.startsWith("/**") || t.startsWith("*/")) {
      collected.unshift(t.replace(/^\/?\*+\/?/, "").trim());
      continue;
    }
    break;
  }
  const text = collected.filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
  return text ? text.slice(0, 200) : undefined;
}

/** Remove balanced `(...)` groups, including nested ones. */
function stripParenGroups(s: string): string {
  let out = "";
  let depth = 0;
  for (const ch of s) {
    if (ch === "(") depth++;
    else if (ch === ")") depth = Math.max(0, depth - 1);
    else if (depth === 0) out += ch;
  }
  return out;
}

const DECL_RE =
  /\b(abstract\s+contract|contract|interface|library)\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*(is\s+([^{]*))?\{/g;

/** Scan one .sol file's source into contract entries. */
export function scanSolidityFile(source: string, file: string): ContractEntry[] {
  const code = blankNonCode(source);
  const lineOf = lineIndex(code);
  const entries: ContractEntry[] = [];

  DECL_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = DECL_RE.exec(code)) !== null) {
    const kind = m[1]!.replace(/\s+/g, " ") as ContractKind;
    const name = m[2]!;
    // Constructor args must go BEFORE the comma split — `is Base(1, 2), Other`
    // otherwise shreds into ["Base", "2)", "Other"].
    const inherits = stripParenGroups(m[4] ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);

    const openIdx = code.indexOf("{", m.index + m[0]!.length - 1);
    const closeIdx = matchBrace(code, openIdx);
    const body = code.slice(openIdx, closeIdx);
    const bodyBase = openIdx;

    const functions: SolFunctionEntry[] = [];
    const fnRe = /\b(function\s+([A-Za-z_$][A-Za-z0-9_$]*)|constructor|receive|fallback)\s*\(([^)]*)\)([^{;]*)/g;
    let f: RegExpExecArray | null;
    while ((f = fnRe.exec(body)) !== null) {
      const fnName = f[2] ?? f[1]!.trim();
      const tail = f[4] ?? "";
      const words = tail.split(/[^A-Za-z]+/);
      functions.push({
        name: fnName,
        visibility: words.find((w) => VISIBILITY.includes(w)) ?? "",
        mutability: words.find((w) => MUTABILITY.includes(w)) ?? "",
        line: lineOf(bodyBase + f.index),
      });
    }

    const names = (re: RegExp): string[] => {
      const out: string[] = [];
      let x: RegExpExecArray | null;
      re.lastIndex = 0;
      while ((x = re.exec(body)) !== null) out.push(x[1]!);
      return out;
    };

    const entry: ContractEntry = {
      name,
      kind,
      file,
      line: lineOf(m.index),
      inherits,
      functions,
      events: names(/\bevent\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*\(/g),
      errors: names(/\berror\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*\(/g),
      modifiers: names(/\bmodifier\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*[({]/g),
    };
    const doc = natspecAbove(source, m.index);
    if (doc) entry.natspec = doc;
    entries.push(entry);

    // Continue AFTER this contract so nested declarations aren't double-counted.
    DECL_RE.lastIndex = closeIdx;
  }
  return entries;
}

/** One-line summary for the run log. */
export function summarizeContracts(entries: ContractEntry[]): string {
  const fns = entries.reduce((n, e) => n + e.functions.length, 0);
  const byKind = (k: ContractKind) => entries.filter((e) => e.kind === k).length;
  return (
    `${byKind("contract") + byKind("abstract contract")} contracts, ` +
    `${byKind("interface")} interfaces, ${byKind("library")} libraries, ${fns} functions`
  );
}
