/**
 * GitHub App creation via the App-Manifest flow — `slowcook app init`.
 *
 * slowcook's agent identity must scale to EVERY consumer org, not one
 * hand-registered app for one repo (Amin's ruling, ledger O2). GitHub's
 * manifest flow makes org-owned App creation a single browser click:
 *
 *   1. slowcook starts a localhost server and opens the browser on a page
 *      that auto-submits the manifest to GitHub's app-creation endpoint;
 *   2. the owner clicks "Create GitHub App" (that click IS the consent);
 *   3. GitHub redirects back to localhost with a one-time code;
 *   4. slowcook exchanges the code (POST /app-manifests/{code}/conversions)
 *      and receives the App id, slug, and PEM — no form ever filled by hand.
 *
 * The App is owned BY THE CONSUMER (their org, their key custody), and once
 * created they install it on any of their repos, whenever they decide —
 * that is the "integrate with every repository" story without slowcook
 * holding anyone's private key. A centrally-published App with hosted
 * token minting is the dash-product variant of the same seam.
 *
 * This module is the pure/HTTP core; the CLI command owns arg parsing and
 * file writes.
 */

export interface ManifestOptions {
  /** App name (globally unique on GitHub). */
  name: string;
  /** Org to own the App; omitted = the signed-in user's account. */
  org?: string;
  /** localhost port the browser flow redirects back to. */
  port: number;
  /** Public = other accounts may install it too. Default false (org-private). */
  makePublic?: boolean;
}

/** The GitHub endpoint the manifest form POSTs to. */
export function manifestSubmitUrl(opts: ManifestOptions): string {
  return opts.org
    ? `https://github.com/organizations/${encodeURIComponent(opts.org)}/settings/apps/new`
    : `https://github.com/settings/apps/new`;
}

/**
 * The manifest slowcook agents need: contents/issues/PRs read-write, no
 * webhook. Exactly the permission set the worker + refine/recipe/brew use.
 */
export function buildManifest(opts: ManifestOptions): Record<string, unknown> {
  return {
    name: opts.name,
    url: "https://github.com/aminazar/slowcook",
    redirect_url: `http://localhost:${opts.port}/callback`,
    public: opts.makePublic ?? false,
    default_permissions: {
      contents: "write",
      issues: "write",
      pull_requests: "write",
      metadata: "read",
    },
  };
}

/** The self-submitting page served to the operator's browser. */
export function manifestFormHtml(opts: ManifestOptions): string {
  const manifest = JSON.stringify(buildManifest(opts))
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;");
  return `<!doctype html><html><body>
<p>Redirecting to GitHub to create the <b>${opts.name}</b> App…
(one click there: <b>Create GitHub App</b>)</p>
<form id="f" action="${manifestSubmitUrl(opts)}" method="post">
<input type="hidden" name="manifest" value="${manifest}">
</form>
<script>document.getElementById("f").submit()</script>
</body></html>`;
}

export interface CreatedApp {
  id: number;
  slug: string;
  pem: string;
  htmlUrl: string;
  installUrl: string;
}

/** Shape-check GitHub's conversion response; throws with a named cause. */
export function parseConversionResponse(data: unknown): CreatedApp {
  const d = data as { id?: number; slug?: string; pem?: string; html_url?: string };
  if (typeof d?.id !== "number" || typeof d?.pem !== "string" || typeof d?.slug !== "string") {
    throw new Error(
      "slowcook: GitHub's app-manifest conversion response is missing id/slug/pem — " +
        "the one-time code may have expired (they last ~1 hour); re-run `slowcook app init`."
    );
  }
  return {
    id: d.id,
    slug: d.slug,
    pem: d.pem,
    htmlUrl: d.html_url ?? `https://github.com/apps/${d.slug}`,
    installUrl: `https://github.com/apps/${d.slug}/installations/new`,
  };
}

/** Exchange the redirect code for the created App's credentials. */
export async function convertManifestCode(code: string): Promise<CreatedApp> {
  const res = await fetch(
    `https://api.github.com/app-manifests/${encodeURIComponent(code)}/conversions`,
    {
      method: "POST",
      headers: {
        accept: "application/vnd.github+json",
        "user-agent": "slowcook-ai/forge-github app-manifest",
      },
    }
  );
  if (!res.ok) {
    throw new Error(
      `slowcook: app-manifest conversion failed (HTTP ${res.status}). ` +
        `The one-time code is single-use and short-lived — re-run \`slowcook app init\`.`
    );
  }
  return parseConversionResponse(await res.json());
}
