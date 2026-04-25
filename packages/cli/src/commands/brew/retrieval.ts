import { Project, Node, SyntaxKind } from "ts-morph";
import type { SourceFile, ClassDeclaration, InterfaceDeclaration } from "ts-morph";
import { existsSync } from "node:fs";
import { join, relative as pathRelative, sep } from "node:path";

/**
 * 0.12.0+ — symbol-aware retrieval tools backed by ts-morph.
 *
 * These tools answer "what's already here?" — the question the
 * mandatory pre-write discovery requirement (Phase 1) makes the agent
 * ask before it adds new exported symbols. The bounded-attention
 * north star of the brownfield-retrieval plan: agent attention should
 * be bounded to the AREA the feature touches, never the project, and
 * within the area, look at existing entities BEFORE creating new ones.
 *
 * We deliberately don't use TypeScript's language service (no
 * type-checking) — that's an order of magnitude slower and we don't
 * need correctness here, we need speed. Syntax tree walks find ~95%
 * of what the agent needs and false positives (an identifier in a
 * comment, say) are recoverable: the agent reads the matched file
 * and decides.
 *
 * Each call loads a fresh ts-morph Project. That's ~200-500ms for a
 * mid-size codebase — the LLM round-trip dominates wall-clock so
 * caching across calls is a future optimization (and tricky because
 * brew's writes invalidate the project).
 */

export interface Reference {
  file: string;
  line: number;
  column: number;
  /** The line of code containing the reference, for context in the agent's prompt. */
  context: string;
  /** What kind of usage — "definition", "reference", "implements", "extends", "import". */
  kind: ReferenceKind;
}

export type ReferenceKind =
  | "definition"
  | "reference"
  | "implements"
  | "extends"
  | "import";

const SOURCE_GLOBS = [
  "src/**/*.ts",
  "src/**/*.tsx",
  "src/**/*.mts",
  "src/**/*.cts",
];

/**
 * Build a ts-morph Project pointing at the consumer's src/ tree.
 * Returns null when there's no src/ — caller should handle "no
 * results" the same way as "src not found."
 */
function buildProject(repoRoot: string): Project | null {
  if (!existsSync(join(repoRoot, "src"))) return null;
  const project = new Project({
    useInMemoryFileSystem: false,
    skipAddingFilesFromTsConfig: true,
    skipFileDependencyResolution: true,
  });
  project.addSourceFilesAtPaths(SOURCE_GLOBS.map((g) => join(repoRoot, g)));
  return project;
}

function relPath(repoRoot: string, abs: string): string {
  return pathRelative(repoRoot, abs).split(sep).join("/");
}

function lineContext(sf: SourceFile, lineNumber: number): string {
  const lines = sf.getFullText().split("\n");
  const text = lines[lineNumber - 1] ?? "";
  // Strip leading whitespace + truncate. Keeping ~120 chars is enough
  // to identify the line without bloating the agent's prompt.
  return text.trim().slice(0, 160);
}

/**
 * Find every place a symbol name is referenced in the source tree.
 *
 * Matches: identifier nodes with text === symbol. Includes the
 * symbol's own definition unless `excludeDefinitions` is set.
 *
 * Excludes:
 *   - Comments (text-search would catch them; AST walk doesn't)
 *   - String literals (same)
 *   - JSX text content
 *
 * Hits the import-statement specifier separately (kind: "import")
 * so the agent can distinguish "imported here" from "called here".
 */
export function findReferences(
  repoRoot: string,
  symbol: string,
  options: { excludeDefinitions?: boolean; maxResults?: number } = {}
): Reference[] {
  const project = buildProject(repoRoot);
  if (!project) return [];
  const max = options.maxResults ?? 100;
  const results: Reference[] = [];

  for (const sf of project.getSourceFiles()) {
    if (results.length >= max) break;
    const rel = relPath(repoRoot, sf.getFilePath());

    sf.forEachDescendant((node) => {
      if (results.length >= max) return;
      if (!Node.isIdentifier(node)) return;
      if (node.getText() !== symbol) return;

      // Determine kind: is this a definition, an import, or a reference?
      const parent = node.getParent();
      let kind: ReferenceKind = "reference";

      if (parent && Node.isImportSpecifier(parent)) {
        kind = "import";
      } else if (parent && Node.isImportClause(parent)) {
        kind = "import";
      } else if (
        (Node.isFunctionDeclaration(parent) ||
          Node.isClassDeclaration(parent) ||
          Node.isInterfaceDeclaration(parent) ||
          Node.isTypeAliasDeclaration(parent) ||
          Node.isVariableDeclaration(parent) ||
          Node.isEnumDeclaration(parent)) &&
        parent.getNameNode?.() === node
      ) {
        kind = "definition";
      }

      if (options.excludeDefinitions && kind === "definition") return;

      const start = node.getStart();
      const lineAndCol = sf.getLineAndColumnAtPos(start);
      results.push({
        file: rel,
        line: lineAndCol.line,
        column: lineAndCol.column,
        context: lineContext(sf, lineAndCol.line),
        kind,
      });
    });
  }

  return results;
}

/**
 * Find every class that implements an interface (or every interface that
 * extends another interface) by name. Returns the implementor's location.
 *
 * Catches:
 *   - `class Foo implements IBar { ... }` → implementations of `IBar`
 *   - `interface Foo extends IBar { ... }` → extensions of `IBar`
 *   - `class Foo extends Bar` → kind: "extends" (kept distinct from
 *     "implements" so the agent can tell hierarchy from interface
 *     conformance)
 */
export function findImplementations(
  repoRoot: string,
  interfaceName: string,
  options: { maxResults?: number } = {}
): Reference[] {
  const project = buildProject(repoRoot);
  if (!project) return [];
  const max = options.maxResults ?? 100;
  const results: Reference[] = [];

  for (const sf of project.getSourceFiles()) {
    if (results.length >= max) break;
    const rel = relPath(repoRoot, sf.getFilePath());

    for (const cls of sf.getClasses()) {
      if (results.length >= max) break;
      // implements clauses
      for (const impl of cls.getImplements()) {
        if (impl.getExpression().getText() === interfaceName) {
          const lineAndCol = sf.getLineAndColumnAtPos(cls.getStart());
          results.push({
            file: rel,
            line: lineAndCol.line,
            column: lineAndCol.column,
            context: lineContext(sf, lineAndCol.line),
            kind: "implements",
          });
        }
      }
      // extends clause (kind: "extends")
      const ext = cls.getExtends();
      if (ext && ext.getExpression().getText() === interfaceName) {
        const lineAndCol = sf.getLineAndColumnAtPos(cls.getStart());
        results.push({
          file: rel,
          line: lineAndCol.line,
          column: lineAndCol.column,
          context: lineContext(sf, lineAndCol.line),
          kind: "extends",
        });
      }
    }

    for (const iface of sf.getInterfaces()) {
      if (results.length >= max) break;
      for (const ext of iface.getExtends()) {
        if (ext.getExpression().getText() === interfaceName) {
          const lineAndCol = sf.getLineAndColumnAtPos(iface.getStart());
          results.push({
            file: rel,
            line: lineAndCol.line,
            column: lineAndCol.column,
            context: lineContext(sf, lineAndCol.line),
            kind: "extends",
          });
        }
      }
    }
  }

  return results;
}

/**
 * Find the declaration site of a named symbol. Returns the FIRST match —
 * a symbol can be re-declared in multiple files (TS allows this for
 * augmenters / module declarations) but the common case is one
 * canonical home.
 *
 * Scans:
 *   - function declarations
 *   - class declarations
 *   - interface declarations
 *   - type alias declarations
 *   - enum declarations
 *   - exported variable declarations
 */
export function findDefinition(
  repoRoot: string,
  symbol: string
): Reference | null {
  const project = buildProject(repoRoot);
  if (!project) return null;

  for (const sf of project.getSourceFiles()) {
    const rel = relPath(repoRoot, sf.getFilePath());
    const candidates = [
      ...sf.getFunctions(),
      ...sf.getClasses(),
      ...sf.getInterfaces(),
      ...sf.getTypeAliases(),
      ...sf.getEnums(),
      ...sf.getVariableDeclarations(),
    ];
    for (const decl of candidates) {
      const nameNode = (decl as ClassDeclaration | InterfaceDeclaration).getNameNode?.();
      const name = nameNode?.getText() ?? "";
      if (name === symbol) {
        const start = decl.getStart();
        const lineAndCol = sf.getLineAndColumnAtPos(start);
        return {
          file: rel,
          line: lineAndCol.line,
          column: lineAndCol.column,
          context: lineContext(sf, lineAndCol.line),
          kind: "definition",
        };
      }
    }
  }
  return null;
}

/**
 * 0.12.0+ — render retrieval results as a compact markdown block for
 * the agent's tool output. Each result becomes a single line:
 * `kind | file:line:col | context`.
 *
 * Truncates at `max` to keep tool output under the agent's response
 * cap. Caller passes a sensible max; default 30 is enough for the
 * common case (most symbols have < 30 references in a focused codebase).
 */
export function renderReferences(refs: Reference[], max = 30): string {
  if (refs.length === 0) return "(no references found)";
  const truncated = refs.slice(0, max);
  const lines = truncated.map(
    (r) => `${r.kind.padEnd(11)} | ${r.file}:${r.line}:${r.column} | ${r.context}`
  );
  if (refs.length > max) {
    lines.push(`(${refs.length - max} more truncated)`);
  }
  return lines.join("\n");
}

void SyntaxKind;
