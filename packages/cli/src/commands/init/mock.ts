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
  return [
    { path: "mock/package.json", contents: PACKAGE_JSON(args.runtimeVersion), skipIfExists: true },
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
  console.log(`Done. Wrote ${written} file(s); skipped ${skipped}.`);
  console.log();
  console.log("Next steps:");
  console.log("  1. cd mock && npm install");
  console.log("  2. npm run dev   # http://localhost:3100");
  console.log("  3. Verify the empty scenario picker renders");
  console.log("  4. Commit + push the mock/ directory");
  console.log("  5. Future vibe runs (slowcook 0.16-α.3+) populate mock/scenarios/ +");
  console.log("     extend mock/src/lib/scenario-registry.ts");
}

/**
 * The mock-runtime package versions track slowcook's overall release
 * cadence. Until 0.16 final cuts we hardcode the latest known version
 * here. After 0.16 the cli's package.json could carry a peer-pin field.
 */
function mockRuntimeVersionFor(_cliVersion: string): string {
  return "^0.1.0";
}

// ---------------- templates ----------------

const PACKAGE_JSON = (runtimeVersion: string) => `{
  "name": "${"$"}{REPO_NAME}-mock",
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
            Review-overlay mount-point. Once @slowcook-ai/review-overlay
            ships (slowcook 0.16-α.5), import + render <SlowcookReviewOverlay />
            here. The overlay provides a floating toggle for nav-mode ↔
            comment-mode and POSTs element-anchored comments to the GitHub
            PR for plate to consume.
          */}
        </ScenarioRegistryProvider>
      </body>
    </html>
  );
}
`;

const PAGE_TSX = `import { ScenarioPicker } from "@slowcook-ai/mock-runtime";

/**
 * Mock app homepage = scenario picker (provided by the runtime).
 *
 * Replaces this with a custom picker if you want different grouping/
 * filtering. The runtime's hooks + registry API are stable; this UI
 * is a default that consumers can swap.
 */
export default function Page() {
  return <ScenarioPicker />;
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
// e.g. import story017 from "../../scenarios/story-017.js";

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
import story017 from "../../scenarios/story-017.js";

export const registry = defineScenarios([story017]);
\`\`\`

Refresh the dev server — the scenario appears in the picker.

## Use scenario data in a component

\`\`\`tsx
"use client";
import { useScenarioFixture } from "@slowcook-ai/mock-runtime";

interface Pin { id: string; rewo_id: string; pinned_at: string; }

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
