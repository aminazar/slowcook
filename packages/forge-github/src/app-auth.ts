/**
 * GitHub App identity for slowcook agents (ledger O2 → feature).
 *
 * Agents that post through an operator's `gh` token show the OPERATOR as
 * the author of every comment and PR — wrong attribution on any consumer
 * repo, not just rewo. A GitHub App gives agents their own visible
 * identity (`<app-slug>[bot]`) that scales per-consumer: each org
 * registers (or installs) a "slowcook-agent" App ONCE, and slowcook mints
 * short-lived installation tokens from the App credentials at run time.
 *
 * The rest of the toolchain is already installation-token-ready — the
 * adapter's `botUsername()` handles the App-token 403 on /user — so this
 * module is deliberately the ONLY new moving part: env → token.
 *
 * Configuration (operator env, e.g. /root/.slowcook-worker.env):
 *   SLOWCOOK_GITHUB_APP_ID                the App's numeric id
 *   SLOWCOOK_GITHUB_APP_PRIVATE_KEY_PATH  path to the App's PEM file
 *   (or SLOWCOOK_GITHUB_APP_PRIVATE_KEY   the PEM itself, if a file is
 *    impractical — path wins when both are set)
 *
 * Installation tokens live ~60 minutes; mint per pass/job, never cache to
 * disk. When the App is not configured, `appAuthConfigured` returns false
 * and callers fall back to whatever token identity they already had.
 */

import { readFileSync } from "node:fs";
import { createAppAuth } from "@octokit/auth-app";
import { Octokit } from "@octokit/rest";

export interface AppAuthEnv {
  SLOWCOOK_GITHUB_APP_ID?: string;
  SLOWCOOK_GITHUB_APP_PRIVATE_KEY_PATH?: string;
  SLOWCOOK_GITHUB_APP_PRIVATE_KEY?: string;
}

export function appAuthConfigured(env: AppAuthEnv = process.env): boolean {
  return Boolean(
    env.SLOWCOOK_GITHUB_APP_ID &&
      (env.SLOWCOOK_GITHUB_APP_PRIVATE_KEY_PATH || env.SLOWCOOK_GITHUB_APP_PRIVATE_KEY)
  );
}

/** Exported for tests; callers use `mintInstallationToken`. */
export function privateKeyFrom(env: AppAuthEnv): string {
  const path = env.SLOWCOOK_GITHUB_APP_PRIVATE_KEY_PATH;
  if (path) {
    const pem = readFileSync(path, "utf8");
    if (!pem.includes("PRIVATE KEY")) {
      throw new Error(
        `slowcook: ${path} does not look like a PEM private key — expected the App's .pem file from GitHub`
      );
    }
    return pem;
  }
  const inline = env.SLOWCOOK_GITHUB_APP_PRIVATE_KEY;
  if (!inline) throw new Error("slowcook: GitHub App private key not configured");
  // Operators often store PEMs in env files with literal \n.
  return inline.replace(/\\n/g, "\n");
}

/**
 * Mint an installation token for one repository. Fails with NAMED causes —
 * an App that is configured but not installed on the target repo is the
 * predictable first-run mistake, and the error must say exactly that.
 */
export async function mintInstallationToken(
  owner: string,
  repo: string,
  env: AppAuthEnv = process.env
): Promise<{ token: string; appSlug: string }> {
  const appId = env.SLOWCOOK_GITHUB_APP_ID;
  if (!appAuthConfigured(env) || !appId) {
    throw new Error(
      "slowcook: GitHub App identity not configured — set SLOWCOOK_GITHUB_APP_ID and SLOWCOOK_GITHUB_APP_PRIVATE_KEY_PATH"
    );
  }
  const privateKey = privateKeyFrom(env);
  const appOctokit = new Octokit({
    authStrategy: createAppAuth,
    auth: { appId: Number(appId), privateKey },
    userAgent: "slowcook-ai/forge-github app-auth",
  });

  let installationId: number;
  let appSlug = "slowcook-agent";
  try {
    const { data } = await appOctokit.apps.getRepoInstallation({ owner, repo });
    installationId = data.id;
    appSlug = data.app_slug ?? appSlug;
  } catch (e) {
    const status = (e as { status?: number }).status;
    if (status === 404) {
      throw new Error(
        `slowcook: GitHub App ${appId} is not installed on ${owner}/${repo}.\n` +
          `  Install it on the repo (GitHub → the App's page → Install) and retry.`
      );
    }
    throw new Error(
      `slowcook: could not resolve the App installation for ${owner}/${repo}: ${(e as Error).message}\n` +
        `  Check SLOWCOOK_GITHUB_APP_ID and that the private key matches the App.`
    );
  }

  const auth = createAppAuth({ appId: Number(appId), privateKey });
  const { token } = await auth({ type: "installation", installationId });
  return { token, appSlug };
}
