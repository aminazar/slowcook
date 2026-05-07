/**
 * 0.19.0-α.13 — single env-var knob for "don't write to the
 * consumer's GitHub repo." Used when a slowcook maintainer (or
 * anyone debugging) replays a slowcook command on someone else's
 * repo — clones, checks out, runs the LLM, gets a verdict, but
 * never commits / pushes / comments / labels / closes.
 *
 * This complements per-command `--dry-run` flags. A command's
 * `--dry-run` typically gates SOME local writes (e.g., persisting
 * a verdict file in `.brewing/`); SLOWCOOK_READ_ONLY gates remote
 * writes specifically. Both can be set together.
 *
 * Pure: just inspects process.env. Tested in isolation.
 */

export function isReadOnlyMode(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = env["SLOWCOOK_READ_ONLY"];
  if (typeof v !== "string") return false;
  // Truthy values: "1", "true", "yes" (case-insensitive). Anything
  // else (including "0", "false", "") is OFF.
  const norm = v.trim().toLowerCase();
  return norm === "1" || norm === "true" || norm === "yes";
}

/**
 * Log-once wrapper: when read-only mode is on, print a single banner
 * to stderr identifying the command. Idempotent: caller can call
 * once at command entry; further log-once is the caller's job.
 */
export function logReadOnlyBanner(commandName: string): void {
  if (isReadOnlyMode()) {
    console.error(`  [SLOWCOOK_READ_ONLY=1] ${commandName} will skip GitHub writes (commits / pushes / comments / labels / closes).`);
  }
}
