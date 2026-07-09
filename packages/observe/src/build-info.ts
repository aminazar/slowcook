// Build identity — kills deploy-window ambiguity. /api/_debug/build answers
// "which code is running?" so every probe/report pins the exact sha, and the
// QA report bundle records what it was reporting against.
export interface BuildInfo { sha: string; builtAt: string | null; startedAt: string; }

const startedAt = new Date().toISOString();
export function buildInfo(): BuildInfo {
  return {
    sha: process.env["BUILD_SHA"] ?? "dev",
    builtAt: process.env["BUILD_AT"] ?? null,
    startedAt,
  };
}
