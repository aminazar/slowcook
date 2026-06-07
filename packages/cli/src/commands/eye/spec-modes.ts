/**
 * design #8 — read a story spec's declared fidelity modes. refine writes
 * `fidelity.modes` on the spec (the contract for which viewport/scheme cells
 * matter); the eye reads it here to build its matrix. Decoupled from the
 * (not-yet-built) #7 `references` field — when that lands, `references.visual[].modes`
 * becomes the per-source override and `fidelity.modes` the spec-level default.
 *
 *   # specs/story-020.yaml
 *   fidelity:
 *     modes: [light, dark, mobile, desktop]
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";

/** Pure: extract `fidelity.modes` from a spec YAML string, or null if absent. */
export function extractFidelityModes(specYaml: string): string[] | null {
  let doc: unknown;
  try {
    doc = YAML.parse(specYaml);
  } catch {
    return null;
  }
  const modes = (doc as { fidelity?: { modes?: unknown } } | null)?.fidelity?.modes;
  if (Array.isArray(modes)) return modes.map((m) => String(m));
  return null;
}

/** Load `fidelity.modes` for a story from `<repoRoot>/specs/story-<id>.yaml`. */
export function loadFidelityModes(repoRoot: string, story: string): string[] | null {
  const p = join(repoRoot, "specs", `story-${story}.yaml`);
  if (!existsSync(p)) return null;
  return extractFidelityModes(readFileSync(p, "utf8"));
}
