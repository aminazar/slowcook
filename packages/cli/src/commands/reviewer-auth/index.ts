// `slowcook reviewer-auth` (0.28.2) — the sign-in helper, standalone.
//
// run-mock has always started the GitHub device-flow helper beside the mock;
// QA-on-a-real-backend consumers (delgoosh/monorepo#869's follow-up) run no
// run-mock, so their pills fell back to PAT-paste-only. This runs the SAME
// helper on its own: point the overlay's `authBase` at it and the pill's
// sign-in grows the one-code GitHub button beside the paste fallback.
//
//   slowcook reviewer-auth [--port 4200] [--expose] [--client-id <id>] [--scope repo]
//
// `--expose` binds 0.0.0.0 for the remote-box case (reviewers' browsers must
// reach it). The client id defaults to slowcook's shipped OAuth app — device
// flow client ids are public identifiers, and the token a reviewer receives
// is scoped by what THEY grant, so no per-consumer app registration is
// needed. Pass --client-id to use your own app anyway.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { GitHubReviewerAuth, SLOWCOOK_REVIEW_OAUTH_CLIENT_ID } from "@slowcook-ai/forge-github";
import { startReviewerAuthServer } from "../run-mock/reviewer-auth-server.js";

export interface ReviewerAuthArgs {
  port?: number;
  expose?: boolean;
  clientId?: string;
  scope?: string;
}

export function parseReviewerAuthArgs(argv: string[]): ReviewerAuthArgs {
  const args: ReviewerAuthArgs = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--port") args.port = parseInt(argv[++i] ?? "", 10) || undefined;
    else if (a === "--expose") args.expose = true;
    else if (a === "--client-id") args.clientId = argv[++i];
    else if (a === "--scope") args.scope = argv[++i];
  }
  return args;
}

export async function reviewerAuth(argv: string[]): Promise<void> {
  const args = parseReviewerAuthArgs(argv);
  const clientId = args.clientId ?? process.env["SLOWCOOK_REVIEW_OAUTH_CLIENT_ID"] ?? SLOWCOOK_REVIEW_OAUTH_CLIENT_ID;
  const auth = new GitHubReviewerAuth({ clientId, scope: args.scope ?? "repo" });
  // 0.28.4 — the shared screentime ledger rides the same helper: one book
  // for every device and origin (localStorage banks are per-origin, which is
  // how one reviewer came to see three disjoint ledgers on a monorepo).
  const ledgerPath = join(homedir(), ".slowcook", "review-screentime.json");
  mkdirSync(dirname(ledgerPath), { recursive: true });
  const handle = await startReviewerAuthServer(auth, {
    clientId,
    preferredPort: args.port ?? 4200,
    host: args.expose ? "0.0.0.0" : "127.0.0.1",
    screentime: {
      io: {
        read: () => { try { return readFileSync(ledgerPath, "utf8"); } catch { return null; } },
        write: (text) => writeFileSync(ledgerPath, text),
      },
    },
  });
  console.log(`reviewer-auth: device-flow sign-in helper on ${handle.url}${args.expose ? " (exposed on 0.0.0.0)" : ""}`);
  console.log(`  point the overlay's authBase at this origin (VITE_SLOWCOOK_AUTH_BASE / NEXT_PUBLIC_SLOWCOOK_AUTH_BASE)`);
  console.log(`  screentime ledger at ${ledgerPath} — the overlay's review-time panel reads/writes ${handle.url}/screentime`);
  console.log(`  client id …${clientId.slice(-4)} · scope ${args.scope ?? "repo"} · Ctrl-C to stop`);
  // keep the process alive until the OS says stop
  await new Promise<void>((resolve) => {
    process.on("SIGINT", () => { handle.close(); resolve(); });
    process.on("SIGTERM", () => { handle.close(); resolve(); });
  });
}
