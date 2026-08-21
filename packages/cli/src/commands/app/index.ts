/**
 * `slowcook app` — GitHub App identity management for slowcook agents.
 *
 *   slowcook app init [--org <org>] [--name <app-name>] [--public]
 *                     [--out-dir <dir>] [--port <n>]
 *
 * One command, one browser click, and the consumer org owns its own
 * slowcook agent App — creation via GitHub's App-Manifest flow (the
 * mechanics live in @slowcook-ai/forge-github/app-manifest). The command
 * then writes the PEM (0600) + an env snippet, and prints the install
 * URL: the owner installs the App on any of their repos, whenever they
 * decide. No central key custody; slowcook never sees anyone's key.
 */

import { createServer } from "node:http";
import { writeFileSync, mkdirSync, chmodSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import {
  manifestFormHtml,
  convertManifestCode,
  type CreatedApp,
  type ManifestOptions,
} from "@slowcook-ai/forge-github";

export async function app(argv: string[]): Promise<void> {
  const sub = argv[0];
  switch (sub) {
    case "init":
      return init(argv.slice(1));
    case undefined:
    case "help":
    case "--help":
    case "-h":
      printHelp();
      return;
    default:
      console.error(`Unknown app subcommand: ${sub}`);
      printHelp();
      process.exit(64);
  }
}

interface InitArgs {
  org?: string;
  name?: string;
  makePublic: boolean;
  outDir: string;
  port: number;
  /** Test seam: skip opening a real browser. */
  noBrowser: boolean;
}

function parseInitArgs(argv: string[]): InitArgs {
  const out: InitArgs = {
    makePublic: false,
    outDir: process.cwd(),
    port: 4207,
    noBrowser: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = argv[i + 1];
    if (a === "--org" && next) { out.org = next; i++; }
    else if (a === "--name" && next) { out.name = next; i++; }
    else if (a === "--out-dir" && next) { out.outDir = resolve(next); i++; }
    else if (a === "--port" && next) { out.port = Number(next) || out.port; i++; }
    else if (a === "--public") { out.makePublic = true; }
    else if (a === "--no-browser") { out.noBrowser = true; }
    else if (a === "--help" || a === "-h") { printHelp(); process.exit(0); }
  }
  return out;
}

async function init(argv: string[]): Promise<void> {
  const args = parseInitArgs(argv);
  const name =
    args.name ?? (args.org ? `slowcook-agent-${args.org}` : "slowcook-agent");
  const opts: ManifestOptions = {
    name,
    port: args.port,
    makePublic: args.makePublic,
    ...(args.org !== undefined ? { org: args.org } : {}),
  };

  const created = await new Promise<CreatedApp>((resolvePromise, rejectPromise) => {
    const server = createServer(async (req, res) => {
      const url = new URL(req.url ?? "/", `http://localhost:${args.port}`);
      if (url.pathname === "/") {
        res.writeHead(200, { "content-type": "text/html" });
        res.end(manifestFormHtml(opts));
        return;
      }
      if (url.pathname === "/callback") {
        const code = url.searchParams.get("code");
        if (!code) {
          res.writeHead(400, { "content-type": "text/plain" });
          res.end("Missing ?code — GitHub did not complete the manifest flow.");
          return;
        }
        try {
          const appCreated = await convertManifestCode(code);
          res.writeHead(200, { "content-type": "text/html" });
          res.end(
            `<html><body><h3>✅ ${appCreated.slug} created.</h3>` +
              `<p>Return to the terminal — credentials are saved there. ` +
              `Next: <a href="${appCreated.installUrl}">install the App on your repos</a>.</p></body></html>`
          );
          server.close();
          resolvePromise(appCreated);
        } catch (e) {
          res.writeHead(500, { "content-type": "text/plain" });
          res.end((e as Error).message);
          server.close();
          rejectPromise(e);
        }
        return;
      }
      res.writeHead(404);
      res.end();
    });
    server.on("error", rejectPromise);
    server.listen(args.port, "127.0.0.1", () => {
      const startUrl = `http://localhost:${args.port}/`;
      console.log(`Opening ${startUrl} — one click on GitHub creates the App.`);
      console.log(`(If no browser opens, visit that URL yourself.)`);
      if (!args.noBrowser) openBrowser(startUrl);
    });
    // The manifest code GitHub issues lasts ~1h; don't hang forever.
    setTimeout(() => {
      server.close();
      rejectPromise(
        new Error("slowcook app init: timed out waiting for the browser flow (15 min).")
      );
    }, 15 * 60_000).unref();
  });

  mkdirSync(args.outDir, { recursive: true });
  const pemPath = join(args.outDir, `${created.slug}.private-key.pem`);
  writeFileSync(pemPath, created.pem, { mode: 0o600 });
  chmodSync(pemPath, 0o600);
  const envPath = join(args.outDir, `${created.slug}.env`);
  writeFileSync(
    envPath,
    `export SLOWCOOK_GITHUB_APP_ID=${created.id}\n` +
      `export SLOWCOOK_GITHUB_APP_PRIVATE_KEY_PATH=${pemPath}\n`,
    { mode: 0o600 }
  );

  console.log(`
✅ GitHub App created: ${created.slug} (id ${created.id})
   ${created.htmlUrl}

Credentials written (keep the PEM secret):
   ${pemPath}
   ${envPath}   ← append these two lines to your worker env
                  (e.g. /root/.slowcook-worker.env on the box)

FINAL STEP — install it on the repos you choose (any repo, any time):
   ${created.installUrl}

Agents then post as ${created.slug}[bot] on every repo you install it on.

Optional polish — give the App the slowcook logo (GitHub only allows
this by hand): ${created.htmlUrl} → Display information → upload
https://raw.githubusercontent.com/aminazar/slowcook/main/docs/screenshots/logo.png`);
}

function openBrowser(url: string): void {
  const cmd =
    process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  try {
    spawn(cmd, [url], { stdio: "ignore", detached: true }).unref();
  } catch {
    // Non-fatal — the URL is printed.
  }
}

function printHelp(): void {
  console.log(`
slowcook app — GitHub App identity for slowcook agents

Usage:
  slowcook app init [--org <org>] [--name <app-name>] [--public]
                    [--out-dir <dir>] [--port <n>] [--no-browser]

init    Create a slowcook agent App OWNED BY YOUR ORG via GitHub's
        App-Manifest flow: one browser click, no forms. Writes the App's
        PEM + an env snippet, and prints the install URL — install the
        App on any of your repositories, whenever you decide. Agents
        authenticated with these credentials post as <app-slug>[bot].

        --org      org to own the App (default: your user account)
        --name     App name (default: slowcook-agent[-<org>]; globally unique)
        --public   allow OTHER accounts to install your App too
        --out-dir  where to write the PEM + env snippet (default: cwd)

The worker prefers this identity automatically once
SLOWCOOK_GITHUB_APP_ID + SLOWCOOK_GITHUB_APP_PRIVATE_KEY_PATH are in its
environment. See \`slowcook worker --help\`.
`);
}
