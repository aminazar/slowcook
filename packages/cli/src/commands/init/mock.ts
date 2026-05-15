/**
 * `slowcook init mock` — scaffold the consumer's mock/ directory.
 *
 * Writes the consumer-side shell of the singular mock app: package.json
 * (depending on @slowcook-ai/mock-runtime + next + react), Dockerfile,
 * tsconfig, next.config.js, postcss.config.mjs, layout.tsx, page.tsx,
 * scenario-registry.ts, globals.css (copied from src/app/globals.css if
 * present), .gitignore, README.md.
 *
 * Refuses to overwrite existing files unless --force.
 *
 * After running this once, the consumer commits + pushes; vibe runs
 * after (slowcook 0.16-α.3+) populate `mock/scenarios/` + extend
 * `mock/src/lib/scenario-registry.ts`.
 */

import { writeFileSync, existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";

interface MockInitArgs {
  cwd: string;
  force: boolean;
  dryRun: boolean;
  /** Pinned version of @slowcook-ai/mock-runtime to depend on. */
  runtimeVersion: string;
}

interface FileToWrite {
  path: string;
  contents: string;
  /** When true and file exists, write only on --force. */
  skipIfExists?: boolean;
  /** When set, only write if no existing globals.css to copy from. */
  fallbackOnly?: boolean;
}

export function parseMockInitArgs(argv: string[], runtimeVersion: string): MockInitArgs {
  const args: MockInitArgs = {
    cwd: process.cwd(),
    force: false,
    dryRun: false,
    runtimeVersion,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = argv[i + 1];
    if (a === "--cwd" && next) { args.cwd = next; i++; }
    else if (a === "--force") { args.force = true; }
    else if (a === "--dry-run") { args.dryRun = true; }
    else if (a === "--runtime-version" && next) { args.runtimeVersion = next; i++; }
    else if (a === "--help" || a === "-h") {
      printHelp();
      process.exit(0);
    }
  }
  return args;
}

function printHelp(): void {
  console.log(`
slowcook init mock — scaffold the consumer's mock/ directory

Writes the consumer-side shell of the singular UI mock app.
Imports its runtime (Scenario types, hooks, ScenarioPicker,
ScenarioRegistryProvider) from @slowcook-ai/mock-runtime so updates
ship via npm bump rather than a re-init.

Usage:
  slowcook init mock [--cwd <path>] [--force] [--dry-run]

Options:
  --cwd <path>             Repo root (default: cwd).
  --force                  Overwrite existing files.
  --dry-run                Print planned actions without writing.
  --runtime-version <v>    Pin of @slowcook-ai/mock-runtime (default: matches cli version).

What it writes:
  mock/package.json                      depends on @slowcook-ai/mock-runtime + next + react
  mock/Dockerfile                        multi-stage; runs on port 3100
  mock/tsconfig.json                     path aliases @/* → src/*; @/mock/* → lib/mock-runtime/*
  mock/next.config.js                    turbopack root pinned to mock/ (avoids parent-src auto-discovery)
  mock/postcss.config.mjs                @tailwindcss/postcss plugin
  mock/.gitignore                        node_modules, .next, .turbo, .env*.local
  mock/README.md                         what the mock is + scenario authoring guide
  mock/src/app/layout.tsx                root layout; ScenarioRegistryProvider wraps children
  mock/src/app/page.tsx                  renders <ScenarioPicker /> from the runtime
  mock/src/app/globals.css               copied from src/app/globals.css if present, else a minimal
                                         Tailwind-v4 directives file (consumer expected to extend)
  mock/src/lib/scenario-registry.ts      consumer-owned; vibe extends this with scenario imports
  mock/scenarios/.gitkeep                empty until vibe writes story-N.ts files
`);
}

function detectMockPackageName(args: MockInitArgs): string {
  // Try the parent package.json's name; fall back to "slowcook-mock".
  // npm rejects `${...}` in name, so the previous literal placeholder
  // broke `npm install` — bug fix in 0.16.0-alpha.11.
  try {
    const parent = JSON.parse(
      readFileSync(join(args.cwd, "package.json"), "utf8")
    ) as { name?: string };
    if (parent.name && /^[a-z0-9_-]/i.test(parent.name)) {
      // Strip leading @scope/
      const base = parent.name.replace(/^@[^/]+\//, "");
      return `${base}-mock`;
    }
  } catch { /* ignore */ }
  return "slowcook-mock";
}

export function planMockFiles(args: MockInitArgs): FileToWrite[] {
  const productionGlobals = join(args.cwd, "src/app/globals.css");
  let globalsContents: string;
  let globalsNote: string;
  if (existsSync(productionGlobals)) {
    try {
      globalsContents = readFileSync(productionGlobals, "utf8");
      globalsNote = `(copied from src/app/globals.css — design tokens shared with production)`;
    } catch {
      globalsContents = MINIMAL_GLOBALS_CSS;
      globalsNote = "(could not read src/app/globals.css; wrote minimal Tailwind directives — extend manually)";
    }
  } else {
    globalsContents = MINIMAL_GLOBALS_CSS;
    globalsNote = "(no src/app/globals.css found; wrote minimal Tailwind directives — extend manually)";
  }
  const pkgName = detectMockPackageName(args);
  return [
    { path: "mock/package.json", contents: PACKAGE_JSON(args.runtimeVersion, pkgName), skipIfExists: true },
    { path: "mock/Dockerfile", contents: DOCKERFILE, skipIfExists: true },
    { path: "mock/tsconfig.json", contents: TSCONFIG, skipIfExists: true },
    { path: "mock/next.config.js", contents: NEXT_CONFIG, skipIfExists: true },
    { path: "mock/postcss.config.mjs", contents: POSTCSS_CONFIG, skipIfExists: true },
    { path: "mock/.gitignore", contents: GITIGNORE, skipIfExists: true },
    { path: "mock/README.md", contents: README, skipIfExists: true },
    { path: "mock/src/app/layout.tsx", contents: LAYOUT_TSX, skipIfExists: true },
    { path: "mock/src/app/page.tsx", contents: PAGE_TSX, skipIfExists: true },
    {
      path: "mock/src/app/globals.css",
      contents: globalsContents + `\n/* ${globalsNote} */\n`,
      skipIfExists: true,
    },
    { path: "mock/src/lib/scenario-registry.ts", contents: SCENARIO_REGISTRY, skipIfExists: true },
    { path: "mock/scenarios/.gitkeep", contents: "", skipIfExists: true },
  ];
}

export async function initMock(argv: string[], cliVersion: string): Promise<void> {
  // 0.19.0+ (sc#82) — `--shape vite` scaffolds a Vite/React SPA mock
  // instead of the legacy Next.js mock. Vite shape is the new default
  // for greenfield consumers; Next.js shape stays for backwards
  // compatibility with consumers already on it.
  const shapeIdx = argv.findIndex((a) => a === "--shape");
  const shape = shapeIdx >= 0 ? argv[shapeIdx + 1] : "vite";
  if (shape !== "vite" && shape !== "nextjs") {
    console.error(`--shape must be 'vite' or 'nextjs', got: ${shape ?? "(missing)"}`);
    process.exit(2);
  }
  if (shape === "vite") {
    const { initMockVite } = await import("./mock-vite.js");
    // Strip the --shape flag + value from argv before delegating.
    const rest = argv.filter((_, i) => i !== shapeIdx && i !== shapeIdx + 1);
    return initMockVite(rest, cliVersion);
  }

  const runtimeVersion = mockRuntimeVersionFor(cliVersion);
  const args = parseMockInitArgs(argv, runtimeVersion);
  const files = planMockFiles(args);

  console.log(`slowcook init mock · cwd: ${relative(process.cwd(), args.cwd) || "."}`);
  console.log(`runtime: @slowcook-ai/mock-runtime@${args.runtimeVersion}`);
  console.log();

  const actions: Array<{ action: "WRITE" | "SKIP"; reason: string; path: string }> = [];
  for (const f of files) {
    const full = join(args.cwd, f.path);
    if (existsSync(full) && !args.force) {
      actions.push({ action: "SKIP", reason: "exists (pass --force to overwrite)", path: f.path });
    } else {
      actions.push({ action: "WRITE", reason: "", path: f.path });
    }
  }

  for (const a of actions) {
    const tag = a.action === "WRITE" ? "WRITE" : "SKIP ";
    console.log(`  ${tag}  ${a.path}${a.reason ? ` (${a.reason})` : ""}`);
  }
  console.log();

  if (args.dryRun) {
    console.log("--dry-run: no files written.");
    return;
  }

  let written = 0;
  let skipped = 0;
  for (const f of files) {
    const full = join(args.cwd, f.path);
    if (existsSync(full) && !args.force) {
      skipped += 1;
      continue;
    }
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, f.contents, "utf8");
    written += 1;
  }

  // Patch the consumer's top tsconfig.json to exclude `mock` so its TS
  // (with mock-only imports like @slowcook-ai/mock-runtime) doesn't
  // pollute consumer-side typecheck. Caught on rewo issue #149: the
  // brew agent burned 2 iters chasing false typecheck errors that came
  // from mock/ files being slurped into the top tsconfig.
  const tsconfigPath = join(args.cwd, "tsconfig.json");
  if (existsSync(tsconfigPath)) {
    const tsconfigUpdated = ensureMockInTsconfigExclude(tsconfigPath);
    if (tsconfigUpdated) {
      console.log(`  PATCH  tsconfig.json (added "mock" to exclude)`);
    } else {
      console.log(`  SKIP   tsconfig.json (mock already in exclude or no exclude field)`);
    }
  }

  // Wire mock as a pnpm-workspace member when the consumer is on pnpm
  // so its node_modules dedupes against the prod tree (Next/React/
  // Vitest/Tailwind are typically the same versions both sides). Two
  // separate node_modules costs ~200-500MB on a typical Next 16 + RTL
  // setup. Discovered post-rewo (2026-05-06) — by which time the rewo
  // mock had its own node_modules + lockfile.
  const wsResult = ensurePnpmWorkspace(args.cwd);
  switch (wsResult.kind) {
    case "added-to-existing":
      console.log(`  PATCH  ${wsResult.path} (appended mock to packages list)`);
      break;
    case "already-listed":
      console.log(`  SKIP   ${wsResult.path} (mock already a workspace member)`);
      break;
    case "created":
      console.log(`  WRITE  ${wsResult.path} (created — pnpm workspace lists [mock])`);
      break;
    case "not-pnpm":
      console.log(`  SKIP   pnpm-workspace.yaml (consumer uses ${wsResult.pkgManager}; recommend pnpm to share node_modules)`);
      break;
  }

  console.log(`Done. Wrote ${written} file(s); skipped ${skipped}.`);
  console.log();
  console.log("Next steps:");
  if (wsResult.kind === "not-pnpm") {
    console.log("  1. cd mock && npm install   # (or yarn install — separate node_modules)");
    console.log("  2. cd mock && npm run dev   # http://localhost:3100");
    console.log("  TIP: pnpm + a workspace would let mock + prod share node_modules");
    console.log("       (saves ~200-500MB). Migrate later via:");
    console.log("         echo 'packages:\\n  - mock' > pnpm-workspace.yaml");
    console.log("         rm -rf node_modules mock/node_modules package-lock.json mock/package-lock.json");
    console.log("         pnpm install");
  } else {
    console.log("  1. pnpm install                 # at repo root — installs both halves");
    console.log("  2. pnpm --filter mock dev      # http://localhost:3100");
  }
  console.log("  3. Verify the empty scenario picker renders");
  console.log("  4. Commit + push the mock/ directory");
  console.log("  5. Future vibe runs (slowcook 0.16-α.3+) populate mock/scenarios/ +");
  console.log("     extend mock/src/lib/scenario-registry.ts");
}

/**
 * Detect the consumer's package manager from lockfile presence.
 * Pure: takes an `exists` predicate so it can be unit-tested without IO.
 */
export function detectPackageManager(
  cwd: string,
  exists: (p: string) => boolean,
): "pnpm" | "npm" | "yarn" | "unknown" {
  if (exists(join(cwd, "pnpm-lock.yaml")) || exists(join(cwd, "pnpm-workspace.yaml"))) return "pnpm";
  if (exists(join(cwd, "yarn.lock"))) return "yarn";
  if (exists(join(cwd, "package-lock.json"))) return "npm";
  return "unknown";
}

/**
 * Detect whether `mock` is already declared in the consumer's
 * pnpm-workspace.yaml `packages` list. Pure parser — handles the
 * common YAML shapes: flow array (`packages: [mock]`) + block list
 * (`packages:\n  - mock`). Returns true on any literal "mock" entry.
 */
export function isMockInPnpmWorkspace(yamlContent: string): boolean {
  // Strip comments to keep the regex simple.
  const stripped = yamlContent.replace(/#[^\n]*/g, "");
  // Block-list entries: `- mock` or `- "mock"` or `- 'mock'`
  if (/^\s*-\s*["']?mock["']?\s*$/m.test(stripped)) return true;
  // Flow-array form: `packages: [..., mock, ...]`
  const flowMatch = stripped.match(/packages\s*:\s*\[([^\]]*)\]/);
  if (flowMatch) {
    const items = flowMatch[1]!.split(",").map((s) => s.trim().replace(/^["']|["']$/g, ""));
    if (items.includes("mock")) return true;
  }
  return false;
}

/**
 * Result of ensurePnpmWorkspace — what the cli did (if anything) so the
 * caller can print accurate "Next steps" text.
 */
export type EnsureWorkspaceResult =
  | { kind: "added-to-existing"; path: string }
  | { kind: "already-listed"; path: string }
  | { kind: "created"; path: string }
  | { kind: "not-pnpm"; pkgManager: "npm" | "yarn" | "unknown" };

/**
 * Make sure `mock` is a pnpm-workspace member when the consumer is on
 * pnpm. Three paths:
 *   - pnpm-workspace.yaml exists + lists "mock"        → already-listed
 *   - pnpm-workspace.yaml exists + missing "mock"      → added-to-existing
 *   - pnpm-lock.yaml present + no workspace.yaml       → created (block-list shape)
 *   - npm/yarn/unknown (no pnpm signal)                → not-pnpm
 *
 * We DON'T auto-migrate npm/yarn consumers — that requires re-resolving
 * the lockfile and is too invasive for an `init mock` step. Caller
 * prints a one-line recommendation in that case.
 *
 * Conservative writes: when adding to an existing block-list workspace,
 * we append a new `- mock` line preserving prior content; we never
 * rewrite the whole file.
 */
export function ensurePnpmWorkspace(cwd: string): EnsureWorkspaceResult {
  const pkgMgr = detectPackageManager(cwd, existsSync);
  if (pkgMgr !== "pnpm") {
    return { kind: "not-pnpm", pkgManager: pkgMgr };
  }
  const workspacePath = join(cwd, "pnpm-workspace.yaml");
  const relPath = "pnpm-workspace.yaml";
  if (existsSync(workspacePath)) {
    const original = readFileSync(workspacePath, "utf8");
    if (isMockInPnpmWorkspace(original)) {
      return { kind: "already-listed", path: relPath };
    }
    // Append a `- mock` entry to the existing packages list. If we can't
    // find a `packages:` block, fall through to create it.
    let updated: string;
    if (/^packages\s*:/m.test(original)) {
      // Existing block-list — append at the end of the list.
      // Heuristic: find the last `-` line under packages: and add after.
      // Simplest correct: append `\n  - mock\n` after `packages:`'s last
      // child (we accept slight indentation imperfection over parser risk).
      const lines = original.split("\n");
      let lastBlockIdx = -1;
      let inPackages = false;
      for (let i = 0; i < lines.length; i++) {
        if (/^packages\s*:/.test(lines[i]!)) { inPackages = true; continue; }
        if (!inPackages) continue;
        if (/^\s*-\s+/.test(lines[i]!)) lastBlockIdx = i;
        else if (/^\S/.test(lines[i]!) && lines[i]!.trim() !== "") break;
      }
      if (lastBlockIdx === -1) {
        // packages: is empty or flow form; append a fresh block-list line.
        updated = original.replace(/(^packages\s*:.*$)/m, `$1\n  - mock`);
      } else {
        // Preserve the indent of the prior list item.
        const priorIndent = lines[lastBlockIdx]!.match(/^(\s*)-/)![1] ?? "  ";
        lines.splice(lastBlockIdx + 1, 0, `${priorIndent}- mock`);
        updated = lines.join("\n");
      }
    } else {
      updated = original.trimEnd() + `\npackages:\n  - mock\n`;
    }
    writeFileSync(workspacePath, updated, "utf8");
    return { kind: "added-to-existing", path: relPath };
  }
  // No workspace.yaml — create a minimal one. Block-list form is more
  // approachable than flow-array for downstream edits.
  const fresh = `# pnpm workspace — auto-created by 'slowcook init mock' so the\n# mock app shares node_modules with the prod tree (no duplicate installs).\npackages:\n  - mock\n`;
  writeFileSync(workspacePath, fresh, "utf8");
  return { kind: "created", path: relPath };
}

/**
 * Patch the consumer's tsconfig.json so `mock` is in the `exclude`
 * array. Idempotent — returns false when nothing changed.
 *
 * tsconfig.json may legitimately contain trailing commas + comments
 * (TypeScript's parser tolerates both). We use a conservative regex
 * approach: find the existing `"exclude": [...]` line + append `"mock"`
 * if it isn't already there. If no `exclude` field exists, leave the
 * file alone (consumer can add it themselves; we don't want to risk
 * malforming a file with comments).
 */
export function ensureMockInTsconfigExclude(tsconfigPath: string): boolean {
  if (!existsSync(tsconfigPath)) return false;
  const original = readFileSync(tsconfigPath, "utf8");
  const excludeMatch = original.match(/"exclude"\s*:\s*\[([^\]]*)\]/);
  if (!excludeMatch) return false; // No exclude field — leave alone
  const arrBody = excludeMatch[1]!;
  // Already excludes mock? Match `"mock"` as a whole-word entry.
  if (/"mock"\s*(,|$)/m.test(arrBody) || /,\s*"mock"\s*(,|$)/m.test(arrBody)) {
    return false;
  }
  // Insert "mock" before the closing bracket. Preserve trailing comma
  // semantics: if arrBody is empty (`[]`), write `["mock"]`; otherwise
  // `..., "mock"`.
  const trimmedBody = arrBody.trim();
  const newBody = trimmedBody.length === 0 ? `"mock"` : `${arrBody.replace(/\s*$/, "")}, "mock"`;
  const updated = original.replace(excludeMatch[0], `"exclude": [${newBody}]`);
  if (updated === original) return false;
  writeFileSync(tsconfigPath, updated, "utf8");
  return true;
}

/**
 * The mock-runtime package versions track slowcook's overall release
 * cadence. Until 0.16 final cuts we hardcode the latest known version
 * here. After 0.16 the cli's package.json could carry a peer-pin field.
 */
export function mockRuntimeVersionFor(_cliVersion: string): string {
  // Pin to ^0.3.0 — what's actually on npm. ^ picks up 0.3.x patches
  // when they publish; bumping major needs an intentional cli release.
  return "^0.3.0";
}

// ---------------- templates ----------------

const PACKAGE_JSON = (runtimeVersion: string, name: string) => `{
  "name": "${name}",
  "version": "0.0.0",
  "private": true,
  "description": "Singular UI mock app. Run with \`npm run dev\` on :3100. See mock/README.md.",
  "type": "module",
  "scripts": {
    "dev": "next dev -p 3100",
    "build": "next build",
    "start": "next start -p 3100",
    "lint": "next lint"
  },
  "dependencies": {
    "@slowcook-ai/mock-runtime": "${runtimeVersion}",
    "next": "^16.0.0",
    "react": "^19.0.0",
    "react-dom": "^19.0.0"
  },
  "devDependencies": {
    "@tailwindcss/postcss": "^4",
    "@types/node": "^22",
    "@types/react": "^19",
    "@types/react-dom": "^19",
    "tailwindcss": "^4",
    "typescript": "^5"
  }
}
`;

const DOCKERFILE = `# Singular UI mock — runnable on the consumer's box per scenario.
# Build (from repo root):   docker build -t mock -f mock/Dockerfile .
# Run:                      docker run -p 3100:3100 mock
# Open:                     http://localhost:3100/?scenario=story-N

FROM node:20-alpine AS deps
WORKDIR /app
COPY mock/package.json mock/package-lock.json* ./
RUN if [ -f package-lock.json ]; then npm ci; else npm install; fi

FROM node:20-alpine AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY mock ./
RUN npm run build

FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3100
ENV HOSTNAME=0.0.0.0
COPY --from=builder /app/public ./public
COPY --from=builder /app/.next ./.next
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./package.json
EXPOSE 3100
CMD ["npm", "run", "start"]
`;

const TSCONFIG = `{
  "compilerOptions": {
    "target": "ES2017",
    "lib": ["dom", "dom.iterable", "esnext"],
    "allowJs": true,
    "skipLibCheck": true,
    "strict": true,
    "noEmit": true,
    "esModuleInterop": true,
    "module": "esnext",
    "moduleResolution": "bundler",
    "resolveJsonModule": true,
    "isolatedModules": true,
    "jsx": "react-jsx",
    "incremental": true,
    "plugins": [{ "name": "next" }],
    "baseUrl": ".",
    "paths": {
      "@/*": ["src/*"]
    }
  },
  "include": ["next-env.d.ts", "src/**/*.ts", "src/**/*.tsx", "scenarios/**/*.ts", ".next/types/**/*.ts"],
  "exclude": ["node_modules"]
}
`;

const NEXT_CONFIG = `import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  images: { unoptimized: true },
  // Mock app lives inside the consumer's repo. Without an explicit
  // turbopack root, Next walks up + treats the parent as the workspace
  // root, which can pull the parent's src/ into the mock build. Pinning
  // to this directory keeps the mock self-contained.
  turbopack: { root: __dirname },
  outputFileTracingRoot: __dirname,
};

export default nextConfig;
`;

const POSTCSS_CONFIG = `export default {
  plugins: {
    "@tailwindcss/postcss": {},
  },
};
`;

const GITIGNORE = `node_modules
.next
.turbo
out
.env*.local
`;

const MINIMAL_GLOBALS_CSS = `@import "tailwindcss";

/*
 * No src/app/globals.css was found at init time. This is a minimal
 * Tailwind-v4 directives file. Add your project's tokens (CSS custom
 * properties, @theme block) here so the mock matches production
 * visually.
 *
 * Vibe + plate work best when this file mirrors production's tokens
 * exactly — they steer toward existing token names, so the better the
 * token coverage here the cleaner their output.
 */

:root {
  --background: #ffffff;
  --foreground: #1a1a1a;
  --card-bg: #ffffff;
  --card-border: rgba(26, 26, 26, 0.06);
}

@media (prefers-color-scheme: dark) {
  :root {
    --background: #0f0f18;
    --foreground: #e8e8f0;
    --card-bg: rgba(255, 255, 255, 0.03);
    --card-border: rgba(255, 255, 255, 0.06);
  }
}

@theme inline {
  --color-background: var(--background);
  --color-foreground: var(--foreground);
  --color-card-bg: var(--card-bg);
  --color-card-border: var(--card-border);
}

body {
  background: var(--background);
  color: var(--foreground);
}
`;

const LAYOUT_TSX = `import type { Metadata } from "next";
import type { ReactNode } from "react";
import { ScenarioRegistryProvider } from "@slowcook-ai/mock-runtime";
import { SlowcookReviewOverlay } from "@slowcook-ai/review-overlay/react";
import { registry } from "@/lib/scenario-registry";
import "./globals.css";

export const metadata: Metadata = {
  title: "mock",
  description: "Singular mock app. Each ?scenario=story-N renders the UI with that story's fixture data.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className="bg-background text-foreground antialiased">
        <ScenarioRegistryProvider registry={registry}>
          {children}
          {/*
            Review-overlay (review-overlay 0.5.1+ auto-detects all
            props from process.env.NEXT_PUBLIC_SLOWCOOK_*). Set those
            in dev (\`slowcook run-mock\` does it for you) to activate.
            Production builds keep them unset so the overlay
            short-circuits to null + tree-shakes out cleanly.
          */}
          <SlowcookReviewOverlay />
        </ScenarioRegistryProvider>
      </body>
    </html>
  );
}
`;

const PAGE_TSX = `"use client";

import { ScenarioPicker } from "@slowcook-ai/mock-runtime";
import { useScenarioCommentStats } from "@slowcook-ai/review-overlay/react";

/**
 * Mock app homepage = scenario picker (provided by the runtime).
 *
 * Replaces this with a custom picker if you want different grouping/
 * filtering. The runtime's hooks + registry API are stable; this UI
 * is a default that consumers can swap.
 *
 * The \`useScenarioCommentStats\` hook (review-overlay 0.4.0+) walks
 * every mockup PR's comments + groups by story_id. Cards then show
 * comment / applied / unresolved / spec-altering counts. Only fires
 * when NEXT_PUBLIC_SLOWCOOK_REVIEW=1 + a PAT is in localStorage.
 */
export default function Page() {
  const stats = useScenarioCommentStats({
    owner: process.env["NEXT_PUBLIC_SLOWCOOK_OWNER"] ?? "",
    repo: process.env["NEXT_PUBLIC_SLOWCOOK_REPO"] ?? "",
    enabled: process.env["NEXT_PUBLIC_SLOWCOOK_REVIEW"] === "1",
  });
  return <ScenarioPicker commentStats={stats ?? undefined} />;
}
`;

const SCENARIO_REGISTRY = `import { defineScenarios } from "@slowcook-ai/mock-runtime";

/**
 * The consumer-owned scenario registry.
 *
 * Vibe extends this when it adds a new scenario:
 *   - one new \`import\` line for the scenario file
 *   - one new entry in the \`defineScenarios([...])\` array
 *
 * Hand-edits are fine too — vibe + plate respect existing entries
 * and only append.
 */

// Vibe-managed imports below this line. Don't reorder; vibe inserts
// new lines at the bottom of the import block.
// e.g. import story017 from "../../scenarios/story-017";

export const registry = defineScenarios([
  // story017,
]);
`;

const README = `# \`mock/\` — singular UI mock app

Per-consumer mock app, scaffolded by \`slowcook init mock\`. The runtime
(scenario types + hooks + picker UI) ships via \`@slowcook-ai/mock-runtime\`;
the bits in this directory are the consumer-owned shell.

## Run it

\`\`\`bash
cd mock
npm install
npm run dev
# → http://localhost:3100
\`\`\`

The homepage is the **scenario picker**. Each scenario maps to one
story (or one flow within a story) — clicking a scenario navigates to
that story's preferred initial path with \`?scenario=story-N\` set.

## Architecture in one paragraph

The mock is the **design contract**. Vibe writes scenarios for each
story (\`mock/scenarios/story-N.ts\`); plate amends per PM feedback;
PM reviews via the live mock URL on the consumer's box. After PM
approves, brew copies the mock's components into \`src/\` and adds the
real-data wiring. The mock + production stay in two separate
filesystems; mock never touches \`src/\`, brew never touches \`mock/\`.

The mock has NO backend. Scenarios are plain TypeScript modules read
by React hooks. Mutations are local component state — they reset on
page reload, which is the right behavior for a mockup (PM either keeps
clicking or refreshes to start over).

## Add a scenario by hand

\`\`\`ts
// mock/scenarios/story-017.ts
import type { Scenario } from "@slowcook-ai/mock-runtime";
// (no \`.js\` extensions in TS imports — Next/Turbopack uses bundler resolution)

const scenario: Scenario = {
  id: "017",
  name: "Owner with 3 pins, 8 reactions",
  user: { id: "amin", handle: "amin", display_name: "Amin Azar" },
  initialPath: "/u/amin",
  fixtures: {
    pins: [/* ... */],
    reactions: [/* ... */],
  },
  expectedInteractions: [
    "Click Pin on first reaction → strip prepends",
    "Click Pinned on strip card → strip removes; reaction's Pin re-enables",
  ],
};

export default scenario;
\`\`\`

Then add to the registry in \`mock/src/lib/scenario-registry.ts\`:

\`\`\`ts
import { defineScenarios } from "@slowcook-ai/mock-runtime";
import story017 from "../../scenarios/story-017";

export const registry = defineScenarios([story017]);
\`\`\`

Refresh the dev server — the scenario appears in the picker.

## Use scenario data in a component

\`\`\`tsx
"use client";
import { useScenarioFixture } from "@slowcook-ai/mock-runtime";

interface Pin { id: string; item_id: string; pinned_at: string; }

export function PinsStrip() {
  const pins = useScenarioFixture<Pin[]>("pins");
  return <div>{pins.map(p => /* ... */)}</div>;
}
\`\`\`

The hook is a typed accessor over \`useScenario().fixtures[domain]\`.
It throws a clear error in dev when the scenario doesn't have that
domain populated.

## Roadmap

- \`@slowcook-ai/review-overlay\` package (slowcook 0.16-α.5) — adds
  a floating toggle for nav-mode ↔ comment-mode; comments post to
  the mockup PR with element selector + screenshot + viewport metadata
- \`slowcook preview deploy\` (0.16-α.4) — SSH-deploys the docker
  build to the consumer's box; preview URL posted to PR
- \`slowcook port\` (0.16-α.7) — deterministic copy of mock components
  → \`src/\` (mock + production stay separate filesystems)
- Vibe + plate v2 (0.16-α.3 / α.6) — populate this directory based
  on spec + PM feedback
`;
