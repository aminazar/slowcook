import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, isAbsolute, normalize, join, sep } from "node:path";

/**
 * 0.15.0-α.1 — vibe's output parser + writer.
 *
 * Vibe emits multi-artifact XML-tagged blocks (matching testgen's shape):
 *   <file path="...">contents</file>
 *   <component_change_request component="..." path="...">prose</component_change_request>
 *
 * `parseVibeOutput` extracts the blocks. `writeVibeFiles` writes them to
 * disk under repoRoot, with path-safety checks (no escapes, no absolute
 * paths, must be under repoRoot).
 *
 * Component-change requests are surfaced separately; they don't write
 * files. The plate agent (later) handles them by either applying or
 * rejecting via PM iteration.
 */

export interface VibeFileBlock {
  /** Repo-relative path; validated to be safe. */
  path: string;
  /** File contents verbatim. */
  contents: string;
}

export interface VibeChangeRequest {
  component: string;
  path: string;
  rationale: string;
}

export interface VibeOutput {
  files: VibeFileBlock[];
  changeRequests: VibeChangeRequest[];
}

const FILE_BLOCK_RE = /<file\s+path="([^"]+)">([\s\S]*?)<\/file>/g;
const CHANGE_REQ_RE =
  /<component_change_request\s+component="([^"]+)"\s+path="([^"]+)">([\s\S]*?)<\/component_change_request>/g;

export function parseVibeOutput(body: string): VibeOutput {
  const files: VibeFileBlock[] = [];
  let m: RegExpExecArray | null;
  const fileRe = new RegExp(FILE_BLOCK_RE.source, "g");
  while ((m = fileRe.exec(body)) !== null) {
    const path = m[1]!.trim();
    // Strip leading/trailing newlines from the captured body, but
    // preserve interior formatting verbatim.
    const contents = m[2]!.replace(/^\r?\n/, "").replace(/\s+$/, "") + "\n";
    files.push({ path, contents });
  }

  const changeRequests: VibeChangeRequest[] = [];
  const reqRe = new RegExp(CHANGE_REQ_RE.source, "g");
  while ((m = reqRe.exec(body)) !== null) {
    changeRequests.push({
      component: m[1]!.trim(),
      path: m[2]!.trim(),
      rationale: m[3]!.trim(),
    });
  }

  return { files, changeRequests };
}

/**
 * Validate a vibe-emitted path is safe to write under repoRoot.
 * Rejects absolute paths, parent-dir escapes, and paths that normalize
 * outside the repo.
 *
 * Returns the absolute target path on success; throws on rejection.
 */
export function validateAndResolveVibePath(
  repoRoot: string,
  relPath: string
): string {
  if (isAbsolute(relPath)) {
    throw new Error(
      `Vibe path safety: refusing absolute path: ${JSON.stringify(relPath)}`
    );
  }
  const normalized = normalize(relPath);
  if (normalized.startsWith("..") || normalized === "..") {
    throw new Error(
      `Vibe path safety: refusing parent-dir escape: ${JSON.stringify(relPath)}`
    );
  }
  // Defense in depth: after join, ensure result starts with repoRoot.
  const abs = join(repoRoot, normalized);
  if (!abs.startsWith(repoRoot + sep) && abs !== repoRoot) {
    throw new Error(
      `Vibe path safety: resolved path escaped repoRoot: ${JSON.stringify(relPath)}`
    );
  }
  return abs;
}

export function writeVibeFiles(
  repoRoot: string,
  files: VibeFileBlock[]
): string[] {
  const written: string[] = [];
  for (const f of files) {
    const abs = validateAndResolveVibePath(repoRoot, f.path);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, f.contents, "utf8");
    written.push(f.path);
  }
  return written;
}
