/**
 * `slowcook init mock --shape vite` — scaffold a Vite/React SPA mock.
 *
 * Sibling of the Next.js scaffolder (`mock.ts`). The Vite shape is the
 * preferred default for new consumers as of sc#82 — solves the focus-
 * loss / hydration-mismatch / `'use client'`-everywhere class of bugs
 * that the Next.js shape inherits from production.
 *
 * Layout produced:
 *
 *   mock/
 *   ├── package.json           vite + react + react-router-dom + @slowcook-ai/mock-runtime
 *   ├── vite.config.ts         port 3100; @/ → src/ alias
 *   ├── tsconfig.json          ESNext + bundler resolution + jsx react-jsx
 *   ├── index.html             #root mount
 *   ├── .gitignore             node_modules, dist
 *   ├── README.md              run instructions + how vibe extends the router
 *   └── src/
 *       ├── main.tsx           StrictMode + BrowserRouter + ScenarioRegistryProvider
 *       ├── App.tsx            <Routes /> — vibe appends new screen routes here
 *       ├── design-system/     ← `slowcook brand` populates this; seeded minimal here
 *       │   ├── tokens.ts
 *       │   ├── css.ts
 *       │   └── index.ts
 *       ├── lib/
 *       │   └── scenario-registry.ts
 *       └── apps/.gitkeep
 *
 * Plus, at the repo root:
 *   .brewing/mock.yaml         downstream agents read this to know the shape
 *
 * The design-system files seeded here are MINIMAL — a neutral palette,
 * just enough so `npm run dev` renders something. The full design-system
 * (logo, full primitives, ds-* utility CSS) is the output of the
 * `slowcook brand` agent (Phase 4 of sc#82); it runs once per project
 * and overwrites these seed files.
 */

import { writeFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { SLOWCOOK_LOGO_SVG } from "@slowcook-ai/core";

export interface MockViteInitArgs {
  cwd: string;
  force: boolean;
  dryRun: boolean;
  /** Pinned version of @slowcook-ai/mock-runtime to depend on. */
  runtimeVersion: string;
}

interface FileToWrite {
  path: string;
  contents: string;
  skipIfExists?: boolean;
}

function detectMockPackageName(cwd: string): string {
  try {
    const parent = JSON.parse(readFileSync(join(cwd, "package.json"), "utf8")) as {
      name?: string;
    };
    if (parent.name && /^[@a-z0-9_-]/i.test(parent.name)) {
      const base = parent.name.replace(/^@[^/]+\//, "");
      return `${base}-mock`;
    }
  } catch {
    /* ignore */
  }
  return "slowcook-mock";
}

export function planMockViteFiles(args: MockViteInitArgs): FileToWrite[] {
  const pkgName = detectMockPackageName(args.cwd);
  return [
    { path: "mock/package.json", contents: PACKAGE_JSON(args.runtimeVersion, pkgName), skipIfExists: true },
    { path: "mock/vite.config.ts", contents: VITE_CONFIG, skipIfExists: true },
    { path: "mock/tsconfig.json", contents: TSCONFIG, skipIfExists: true },
    { path: "mock/index.html", contents: INDEX_HTML, skipIfExists: true },
    { path: "mock/.gitignore", contents: GITIGNORE, skipIfExists: true },
    { path: "mock/README.md", contents: README, skipIfExists: true },
    { path: "mock/public/slowcook-logo.svg", contents: SLOWCOOK_LOGO_SVG, skipIfExists: false },
    { path: "mock/src/main.tsx", contents: MAIN_TSX, skipIfExists: true },
    { path: "mock/src/App.tsx", contents: APP_TSX, skipIfExists: true },
    { path: "mock/src/design-system/tokens.ts", contents: TOKENS_TS, skipIfExists: true },
    { path: "mock/src/design-system/css.ts", contents: CSS_TS, skipIfExists: true },
    { path: "mock/src/design-system/index.ts", contents: DS_INDEX_TS, skipIfExists: true },
    { path: "mock/src/lib/scenario-registry.tsx", contents: SCENARIO_REGISTRY, skipIfExists: true },
    { path: "mock/src/apps/.gitkeep", contents: "", skipIfExists: true },
    { path: "mock/scenarios/.gitkeep", contents: "", skipIfExists: true },
    { path: ".brewing/mock.yaml", contents: MOCK_YAML, skipIfExists: true },
  ];
}

export function applyMockViteFiles(args: MockViteInitArgs, files: FileToWrite[]): void {
  for (const f of files) {
    const abs = join(args.cwd, f.path);
    if (existsSync(abs) && f.skipIfExists && !args.force) {
      console.log(`  skip   ${f.path} (exists)`);
      continue;
    }
    if (args.dryRun) {
      console.log(`  would write ${f.path}`);
      continue;
    }
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, f.contents, "utf8");
    console.log(`  write  ${f.path}`);
  }
}

// ---------------------------------------------------------------------------
// Template contents
// ---------------------------------------------------------------------------

const PACKAGE_JSON = (_runtimeVersion: string, pkgName: string): string =>
  JSON.stringify(
    {
      name: pkgName,
      private: true,
      version: "0.0.0",
      type: "module",
      scripts: {
        dev: "vite",
        build: "tsc -b && vite build",
        preview: "vite preview",
        typecheck: "tsc --noEmit",
      },
      // No `@slowcook-ai/mock-runtime` for vite shape — that package pins
      // a `next@>=15` + `react@>=19` peer set incompatible with a Vite
      // SPA. The Vite mock inlines the minimal scenario types + picker
      // directly (see src/lib/scenario-registry.ts). When mock-runtime
      // grows a Vite-compatible build (sc#82 Phase 4-ish), wire it back.
      dependencies: {
        react: "^18.3.1",
        "react-dom": "^18.3.1",
        "react-router-dom": "^6.27.0",
      },
      devDependencies: {
        "@types/react": "^18.3.12",
        "@types/react-dom": "^18.3.1",
        "@vitejs/plugin-react": "^4.3.4",
        typescript: "^5.6.3",
        vite: "^6.0.5",
      },
    },
    null,
    2,
  ) + "\n";

const VITE_CONFIG = `import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

// vite.config.ts — slowcook Vite mock (sc#82).
//
// Port 3100 mirrors the legacy Next.js mock's port so existing tooling
// (slowcook run-mock, dev-env yaml) keeps working without changes.
// '@/' alias makes import paths consistent with the Next.js mock shape
// so agents can read either shape via the same import conventions.
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    port: 3100,
    host: '0.0.0.0',
  },
  preview: {
    port: 3100,
    host: '0.0.0.0',
  },
});
`;

const TSCONFIG = `{
  "compilerOptions": {
    "target": "ESNext",
    "useDefineForClassFields": true,
    "lib": ["ESNext", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "skipLibCheck": true,
    "moduleResolution": "bundler",
    "allowImportingTsExtensions": false,
    "isolatedModules": true,
    "moduleDetection": "force",
    "noEmit": true,
    "jsx": "react-jsx",
    "strict": true,
    "noUnusedLocals": false,
    "noUnusedParameters": false,
    "noFallthroughCasesInSwitch": true,
    "baseUrl": ".",
    "paths": {
      "@/*": ["./src/*"]
    }
  },
  "include": ["src", "vite.config.ts"]
}
`;

const INDEX_HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Mock</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
`;

const GITIGNORE = `node_modules
dist
.env.local
.env.*.local
.vite
`;

const README = `# \`mock/\` — singular UI mock app (Vite/React)

Per-consumer mock app, scaffolded by \`slowcook init mock --shape vite\`.
The runtime (scenario types, hooks, picker UI) ships via
\`@slowcook-ai/mock-runtime\`; the bits in this directory are the
consumer-owned shell.

## Run it

\`\`\`bash
cd mock
npm install
npm run dev
# → http://localhost:3100
\`\`\`

The homepage is the **scenario picker** (mounted at \`/\` by default).
Each scenario maps to one story (or one flow within a story); clicking
a scenario navigates to that story's preferred initial path.

## Where things live

| Path | What it is |
|---|---|
| \`src/App.tsx\` | Top-level \`<Routes>\`. Vibe appends new screen routes here. |
| \`src/main.tsx\` | Root mount + BrowserRouter + ScenarioRegistryProvider. |
| \`src/design-system/\` | Tokens, primitives, icons, layout, css. Output of \`slowcook brand\`. |
| \`src/apps/<role>/screens/\` | One file per screen. Vibe writes these. |
| \`src/lib/scenario-registry.ts\` | Vibe-managed scenario imports. |
| \`scenarios/\` | One file per scenario. Vibe writes these. |

## Why Vite instead of Next.js

The mock is a private dev surface — no SEO, no API routes, no SSR
needed. Vite gives us instant HMR, no \`'use client'\` directives, no
hydration mismatches, and a static build that scp's to a server with
nginx alpine. See sc#82 for the migration rationale.

The brew step still emits Next.js production code; \`slowcook port\`
translates Vite/React-Router screens to Next.js App Router pages.

## Add a scenario by hand

\`\`\`ts
// mock/scenarios/story-017.ts
import type { Scenario } from '@slowcook-ai/mock-runtime';

const scenario: Scenario = {
  id: '017',
  name: 'Owner with 3 pins, 8 reactions',
  user: { id: 'amin', handle: 'amin', display_name: 'Amin Azar' },
  initialPath: '/u/amin',
  fixtures: { /* ... */ },
};

export default scenario;
\`\`\`

Then add to \`mock/src/lib/scenario-registry.tsx\`:

\`\`\`ts
import story017 from '../../scenarios/story-017';
export const registry = defineScenarios([story017]);
\`\`\`
`;

const MAIN_TSX = `import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { App } from './App';
import { ScenarioRegistryProvider } from './lib/scenario-registry';
import { registry } from './lib/scenario-registry';
import { makeGlobalCSS } from './design-system/css';

// Inject the design-system global stylesheet. Replaces the need for a
// separate index.css; vibe/brand can overwrite makeGlobalCSS without
// editing main.tsx.
const styleEl = document.createElement('style');
styleEl.textContent = makeGlobalCSS('en');
document.head.appendChild(styleEl);

const rootEl = document.getElementById('root');
if (!rootEl) throw new Error('No #root element in index.html');

createRoot(rootEl).render(
  <StrictMode>
    <BrowserRouter>
      <ScenarioRegistryProvider registry={registry}>
        <App />
      </ScenarioRegistryProvider>
    </BrowserRouter>
  </StrictMode>,
);
`;

const APP_TSX = `import { Routes, Route, Navigate } from 'react-router-dom';
import { ScenarioPicker } from './lib/scenario-registry';

// ┌──────────────────────────────────────────────────────────────────┐
// │ Vibe-managed route imports — don't reorder; vibe appends below.  │
// └──────────────────────────────────────────────────────────────────┘
// import { Dashboard } from './apps/patient/screens/Dashboard';

export function App() {
  return (
    <Routes>
      <Route path="/" element={<ScenarioPicker />} />

      {/* ┌────────────────────────────────────────────────────────────┐ */}
      {/* │ Vibe-managed routes — don't reorder; vibe appends below.   │ */}
      {/* └────────────────────────────────────────────────────────────┘ */}
      {/* <Route path="/patient/dashboard" element={<Dashboard />} /> */}

      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
`;

const TOKENS_TS = `// design-system/tokens.ts — minimal seed.
//
// \`slowcook brand\` overwrites these tokens with a brand-specific palette
// derived from a brief/screenshot/reference. Until brand runs, agents
// use these neutral values.

export const COLORS = {
  // Brand (neutral seed — slowcook brand overwrites)
  primary:       '#3B82F6',
  primaryLight:  '#60A5FA',
  primaryDark:   '#1D4ED8',
  primaryGhost:  'rgba(59,130,246,0.12)',

  accent:        '#F59E0B',
  accentLight:   '#FBBF24',
  accentGhost:   'rgba(245,158,11,0.15)',

  // Semantic
  success:       '#10B981',
  successGhost:  'rgba(16,185,129,0.12)',
  danger:        '#EF4444',
  dangerGhost:   'rgba(239,68,68,0.12)',
  warn:          '#D97706',
  warnGhost:     '#FEF3C7',

  // Surfaces
  bg:            '#F9FAFB',
  bgDark:        '#111827',
  white:         '#FFFFFF',
  sidebar:       '#F3F4F6',

  // Borders + neutrals
  cardBorder:    'rgba(0,0,0,0.06)',
  sidebarBorder: 'rgba(0,0,0,0.08)',
  sand:          '#D1D5DB',
  cream:         '#F3F4F6',

  // Text
  textDark:      '#111827',
  textMid:       '#4B5563',
  textLight:     '#9CA3AF',
};

export const SPACING = { xs: 4, sm: 8, md: 14, lg: 20, xl: 28, xxl: 40 };
export const RADIUS  = { sm: 8, md: 12, lg: 17, xl: 22, pill: 100, full: '50%' as const };

export const SHADOW = {
  card: '0 2px 18px rgba(0,0,0,0.05)',
  stat: '0 2px 12px rgba(0,0,0,0.04)',
  btn:  '0 3px 12px rgba(59,130,246,0.28)',
  btnAccent: '0 3px 12px rgba(245,158,11,0.30)',
  nav:  '0 -3px 16px rgba(0,0,0,0.08)',
};

export const FONTS = {
  en: {
    heading: "'Inter', sans-serif",
    body:    "'Inter', sans-serif",
    import:  'https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&display=swap',
  },
  fa: {
    heading: "'Vazirmatn', sans-serif",
    body:    "'Vazirmatn', sans-serif",
    import:  'https://fonts.googleapis.com/css2?family=Vazirmatn:wght@300;400;500;600;700&display=swap',
  },
};

export type Lang = keyof typeof FONTS;
`;

const CSS_TS = `import { COLORS, FONTS, RADIUS } from './tokens';
import type { Lang } from './tokens';

// makeGlobalCSS(lang) — returns the full global stylesheet as one
// string. Inject at app root (\`main.tsx\` does this). Direction-aware:
// \`fa\` → RTL, anything else → LTR.
//
// \`slowcook brand\` overwrites this file to encode brand-specific rules
// (animations, ds-* utility classes, custom scrollbars, etc.). The
// seed below is the bare minimum so \`vite dev\` renders readable text.
export function makeGlobalCSS(lang: Lang): string {
  const f = FONTS[lang];
  const dir = lang === 'fa' ? 'rtl' : 'ltr';
  return \`
    @import url('\${f.import}');
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    html { scroll-behavior: smooth; }
    body {
      direction: \${dir};
      font-family: \${f.body};
      background: \${COLORS.bg};
      color: \${COLORS.textDark};
      min-height: 100vh;
      -webkit-font-smoothing: antialiased;
    }
    a { color: \${COLORS.primary}; text-decoration: none; }
    input, textarea, select {
      font-family: \${f.body};
      border: 1px solid \${COLORS.sand};
      border-radius: \${RADIUS.md}px;
      padding: 10px 14px;
      font-size: 13px;
      background: white;
      width: 100%;
    }
    input:focus, textarea:focus, select:focus {
      outline: none;
      border-color: \${COLORS.primary};
      box-shadow: 0 0 0 3px \${COLORS.primaryGhost};
    }
  \`;
}
`;

const DS_INDEX_TS = `// Re-exports — keep one stable import surface for screens:
//   import { COLORS, makeGlobalCSS, ... } from '@/design-system';
//
// \`slowcook brand\` extends this file when it generates primitives.tsx
// and icons.tsx.

export * from './tokens';
export { makeGlobalCSS } from './css';
`;

const SCENARIO_REGISTRY = `import { createContext, useContext, type ReactNode } from 'react';
import { Link } from 'react-router-dom';

// ┌──────────────────────────────────────────────────────────────────┐
// │ Inline scenario primitives — Vite mock has no \`mock-runtime\` dep │
// │ (see mock-vite.ts comment for why). Replace with the upstream    │
// │ package once it ships a Vite-compatible build.                   │
// └──────────────────────────────────────────────────────────────────┘

export interface Scenario {
  id: string;
  name: string;
  description?: string;
  initialPath?: string;
  user?: { id: string; handle: string; display_name: string };
  fixtures?: Record<string, unknown>;
  expectedInteractions?: string[];
}

const Ctx = createContext<{ registry: Scenario[] }>({ registry: [] });

export function ScenarioRegistryProvider({
  registry,
  children,
}: {
  registry: Scenario[];
  children: ReactNode;
}) {
  return <Ctx.Provider value={{ registry }}>{children}</Ctx.Provider>;
}

export function useScenarios(): Scenario[] {
  return useContext(Ctx).registry;
}

export function defineScenarios(items: Scenario[]): Scenario[] {
  return items;
}

export function ScenarioPicker() {
  const scenarios = useScenarios();
  return (
    <main
      style={{
        maxWidth: 720,
        margin: '0 auto',
        padding: '40px 24px',
        fontFamily: 'inherit',
      }}
    >
      <h1 style={{ fontSize: 28, marginBottom: 12 }}>Scenarios</h1>
      <p style={{ color: '#6b7280', marginBottom: 24 }}>
        Pick a scenario to navigate to its initial path.
      </p>
      {scenarios.length === 0 ? (
        <div
          style={{
            padding: 20,
            background: '#F3F4F6',
            borderRadius: 12,
            color: '#4B5563',
          }}
        >
          No scenarios yet. <code>slowcook vibe</code> will add them as stories
          ship.
        </div>
      ) : (
        <ul style={{ listStyle: 'none', display: 'grid', gap: 10 }}>
          {scenarios.map((s) => (
            <li key={s.id}>
              <Link
                to={s.initialPath ?? '/'}
                style={{
                  display: 'block',
                  padding: 16,
                  borderRadius: 12,
                  background: 'white',
                  border: '1px solid rgba(0,0,0,0.08)',
                  color: 'inherit',
                  textDecoration: 'none',
                }}
              >
                <div style={{ fontWeight: 600 }}>{s.name}</div>
                <div
                  style={{
                    fontSize: 12,
                    color: '#6b7280',
                    marginTop: 4,
                  }}
                >
                  story-{s.id} · {s.initialPath ?? '/'}
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}

/**
 * Consumer-owned scenario registry.
 *
 * Vibe extends this when it adds a new scenario:
 *   - one new \`import\` line for the scenario file
 *   - one new entry in the \`defineScenarios([...])\` array
 *
 * Hand-edits are fine — vibe + plate respect existing entries and
 * only append.
 */

// Vibe-managed imports below this line. Don't reorder; vibe inserts
// new lines at the bottom of the import block.
// e.g. import story017 from '../../scenarios/story-017';

export const registry = defineScenarios([
  // story017,
]);
`;

const MOCK_YAML = `# .brewing/mock.yaml — mock shape config (sc#82).
#
# Downstream slowcook agents read this to know where the mock lives
# and what shape it has. Update when migrating between shapes.
schema_version: 1

# vite | nextjs — the runtime + dev-server flavour for mock/.
shape: vite

# Where mock files live, relative to repo root.
mock_root: mock

# Where vibe writes screen files. Glob shape varies by shape:
#   vite:    mock/src/apps/<role>/screens/<Screen>.tsx
#   nextjs:  mock/src/app/<route>/page.tsx
screens_root: mock/src/apps

# Where brand emits the design system. brand runs once per project +
# overwrites these files on --refresh.
design_system_dir: mock/src/design-system

# Where the top-level router lives (vite shape only). Vibe appends new
# routes here.
router_file: mock/src/App.tsx

# Where scenarios live. Vibe writes \`scenarios/story-<id>.ts\` files.
scenarios_dir: mock/scenarios

# Where the scenario registry lives. Vibe appends imports + array entries.
scenario_registry_file: mock/src/lib/scenario-registry.tsx
`;

export async function initMockVite(argv: string[], cliVersion: string): Promise<void> {
  const { mockRuntimeVersionFor } = await import("./mock.js");
  const args: MockViteInitArgs = {
    cwd: process.cwd(),
    force: false,
    dryRun: false,
    runtimeVersion: mockRuntimeVersionFor(cliVersion),
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = argv[i + 1];
    if (a === "--cwd" && next) {
      args.cwd = next;
      i++;
    } else if (a === "--force") {
      args.force = true;
    } else if (a === "--dry-run") {
      args.dryRun = true;
    } else if (a === "--runtime-version" && next) {
      args.runtimeVersion = next;
      i++;
    }
  }
  const files = planMockViteFiles(args);
  applyMockViteFiles(args, files);
  console.log(
    `\nDone. cd mock && npm install && npm run dev → http://localhost:3100\n` +
      `Next: \`slowcook brand\` populates the design system before vibe runs.`,
  );
}
