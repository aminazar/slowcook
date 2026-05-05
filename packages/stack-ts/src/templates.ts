/**
 * Stack-specific scaffold templates consumed by `slowcook init`. Used to
 * live in `@slowcook-ai/cli/src/commands/init/templates.ts`, which meant
 * CLI shipped TypeScript/Vitest-specific assumptions despite slowcook's
 * stack-agnostic pledge. 0.7.0 Phase 1B moves them here so CLI stays
 * neutral.
 *
 * Future stack adapters (`@slowcook-ai/stack-python`, `@slowcook-ai/stack-go`)
 * implement their own equivalents returning pytest / go-test / cargo-test
 * configuration. CLI's init composes the stack's contribution with the
 * forge's contribution and its own forge/stack-neutral core.
 */

export interface TsStackInitParams {
  /** Whether the consumer project has Playwright installed (affects the $doc note). */
  hasPlaywright: boolean;
}

/**
 * `.brewing/stack.json` — tells slowcook how to discover + run tests in a
 * Vitest-based TypeScript project. Callers merge with forge and core
 * contributions at init time.
 */
export function getTsStackConfig(params: TsStackInitParams): string {
  const doc =
    "Project-level stack configuration consumed by slowcook (@slowcook-ai/stack-ts). " +
    "Tells the harness how to discover and run tests. Only include suites that are " +
    "actually runnable — slowcook refuses to record an incomplete manifest." +
    (params.hasPlaywright
      ? " (Playwright detected in package.json; slowcook's playwright discovery is not yet " +
        "implemented, so the e2e suite is intentionally omitted. Add it back post-upgrade.)"
      : "");

  return (
    JSON.stringify(
      {
        $schema: "./stack.schema.json",
        $doc: doc,
        language: "typescript",
        package_manager: "npm",
        test: {
          backend: {
            runner: "vitest",
            run_command: "npx vitest run",
            discover_command: "npx vitest list",
            reporter_format: "vitest-list-lines",
          },
          // 0.9.0+ — tier-2 acceptance suite. Runs Playwright against a
          // real Next.js dev server + real Supabase. Gated on ACCEPTANCE=1
          // so local `npm test` stays fast (handler tier-1 + UI tier-1
          // only). CI acceptance workflow sets the env var.
          acceptance: {
            runner: "playwright",
            run_command: "ACCEPTANCE=1 npx playwright test",
            discover_command: "npx playwright test --list",
            reporter_format: "playwright-list",
          },
        },
        lint: {
          lint_command: "npm run lint",
          typecheck_command: "npm run typecheck",
        },
      },
      null,
      2
    ) + "\n"
  );
}

/**
 * Files the TS stack wants frozen in the consumer's `.brewing/frozen-paths.json`.
 * Composed with the forge adapter's and core's own frozen paths at init time.
 */
export function getTsStackFrozenFiles(): string[] {
  return [
    "vitest.config.ts",
    "vitest.config.mjs",
    "vitest.config.js",
    "playwright.config.ts",
    "playwright.config.mjs",
    "playwright.config.js",
  ];
}

/**
 * Tier-2 frozen DIRECTORIES — acceptance tests are frozen the same way
 * tests/integration is. Emitted by 0.9.0 init so brew can't silently
 * rewrite acceptance specs.
 */
export function getTsStackFrozenDirectories(): string[] {
  return ["tests/acceptance/"];
}

/**
 * Playwright config scaffold emitted by `slowcook init` (0.9.0+).
 * Minimal — chromium-only, no video, screenshot on failure.
 * Consumers customise by adding projects / reporters post-init.
 * Marker on line 1 lets `init --force` detect whether the file is
 * still the scaffold vs hand-edited by the consumer.
 */
export function getPlaywrightConfig(): string {
  return `// @slowcook-one-time-scaffold 0.9.0 — tier-2 acceptance harness
//
// Minimal Playwright config for tier-2 acceptance tests. Adjust freely;
// slowcook's only requirement is that \`npx playwright test\` runs the
// suite under \`tests/acceptance/**\`. See docs/plans/0.9-tier-2-acceptance.md
// for the broader design.

import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/acceptance",
  timeout: 30_000,
  fullyParallel: false, // acceptance tests may share fixtures; parallelize cautiously
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? "list" : "line",
  use: {
    baseURL: process.env.BASE_URL ?? "http://localhost:3000",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "chromium-desktop",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: process.env.ACCEPTANCE_SKIP_WEBSERVER
    ? undefined
    : {
        command: "npm run dev",
        url: process.env.BASE_URL ?? "http://localhost:3000",
        reuseExistingServer: !process.env.CI,
        timeout: 60_000,
      },
});
`;
}

/**
 * Sandbox helper emitted as \`tests/acceptance/_setup/sandbox.ts\` so
 * acceptance tests can boot a full stack (Next + Supabase local) without
 * per-test boilerplate. The marker on line 1 makes it safe for
 * \`init --force\` to refresh without clobbering consumer customisations.
 */
export function getAcceptanceSandboxHelper(): string {
  return `// @slowcook-one-time-scaffold 0.9.0 — tier-2 sandbox helper
//
// Boots a Next dev server + points Playwright at it. Supabase URL +
// anon key are read from .env.acceptance (consumer provides; points at
// a staging project, NEVER prod). See docs/plans/0.9-tier-2-acceptance.md.

import { test as base } from "@playwright/test";

export const test = base.extend<{}>({
  // Consumers extend this with per-test fixtures (authenticated page, seeded
  // record id, etc.). Slowcook's scaffold just re-exports \`test\` so imports
  // converge on one path: \`import { test, expect } from "@tests/acceptance/_setup/sandbox"\`.
});

export { expect } from "@playwright/test";
`;
}

/**
 * Screenshot capture helper emitted at \`tests/acceptance/_setup/screenshots.ts\`
 * (0.9.2+). Wraps Playwright's page.screenshot() with slowcook's viewport×
 * scheme matrix and a stable path convention: \`test-results/screenshots/
 * story-<id>/<viewport>-<scheme>.png\`. CI uploads this directory as an
 * artifact; 0.9.2.x promotes to MinIO storage for retention.
 *
 * Keep the matrix minimal — desktop-light, mobile-light, mobile-dark.
 * Consumers extend via the \`overrides\` arg per-story if their spec's
 * ui_behavior describes more viewports.
 */
export function getAcceptanceScreenshotHelper(): string {
  return `// @slowcook-one-time-scaffold 0.9.2 — tier-2 screenshot capture
//
// Per-viewport × color-scheme screenshots for tier-2 acceptance. Outputs
// land at test-results/screenshots/story-<id>/<viewport>-<scheme>.png;
// Playwright's default test-results/ is already in .gitignore.
// Gate 1/2/3 (slowcook 0.10) will consume these for AI vision review.

import type { Page } from "@playwright/test";

export interface ScreenshotMatrix {
  viewport: { width: number; height: number };
  scheme: "light" | "dark";
  name: string;
}

/** Default matrix. Override per-story when the spec's ui_behavior calls for more. */
export const DEFAULT_MATRIX: ScreenshotMatrix[] = [
  { name: "desktop-light", viewport: { width: 1440, height: 900 }, scheme: "light" },
  { name: "mobile-light", viewport: { width: 390, height: 844 }, scheme: "light" },
  { name: "mobile-dark", viewport: { width: 390, height: 844 }, scheme: "dark" },
];

export interface CaptureOptions {
  page: Page;
  storyId: string;
  /** Override the default matrix — e.g., if the spec only describes one viewport. */
  matrix?: ScreenshotMatrix[];
}

export async function captureScreenshots(options: CaptureOptions): Promise<string[]> {
  const matrix = options.matrix ?? DEFAULT_MATRIX;
  const paths: string[] = [];
  for (const m of matrix) {
    await options.page.setViewportSize(m.viewport);
    await options.page.emulateMedia({ colorScheme: m.scheme });
    // Small settling wait so the colour-scheme transition commits before
    // we snap. Playwright doesn't have a \`wait for media-query to apply\`
    // primitive; 50ms is more than enough in practice.
    await options.page.waitForTimeout(50);
    const path = \`test-results/screenshots/story-\${options.storyId}/\${m.name}.png\`;
    await options.page.screenshot({ path, fullPage: true });
    paths.push(path);
  }
  return paths;
}
`;
}

/**
 * .env.acceptance.example scaffold — makes explicit what the consumer
 * must configure for tier-2 runs without leaking real values.
 */
export function getAcceptanceEnvExample(): string {
  return `# Acceptance test env vars. Copy to .env.acceptance and fill in values
# from a STAGING Supabase project (never prod).

# Next app base URL (dev server; Playwright's webServer config boots this)
BASE_URL=http://localhost:3000

# Supabase project credentials — anon key only; service-role stays out
NEXT_PUBLIC_SUPABASE_URL=https://<staging-ref>.supabase.co
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY=<anon-key>

# Pre-seeded test user (acceptance tests don't sign up; use a known account)
ACCEPTANCE_TEST_EMAIL=test-acceptance@example.com
ACCEPTANCE_TEST_HANDLE=acceptance_user
`;
}

/**
 * One-time-per-repo UI testing helpers, emitted by `slowcook init` so
 * tier-1 UI tests (0.7.5+) can import render / fetch / a11y utilities
 * without every test reinventing them. Each helper starts with a
 * `// @slowcook-one-time-scaffold` marker on line 1 — `init --force`
 * overwrites files only if that marker is still present (preserves
 * consumer customisations).
 *
 * Consumers must add the listed devDependencies (see
 * `getTsUiDevDependencies()`) and route `.tsx` tests to jsdom via
 * `environmentMatchGlobs: [["**\/*.test.tsx", "jsdom"]]` in their
 * `vitest.config.ts`. Init surfaces both requirements as post-run
 * instructions — slowcook doesn't own `vitest.config.ts` or
 * `package.json` so we can't patch them directly.
 */
export interface UiTestingHelperArtifact {
  path: string;
  contents: string;
}

export function getTsUiTestingHelpers(): UiTestingHelperArtifact[] {
  return [
    { path: "tests/helpers/render.tsx", contents: renderHelper() },
    { path: "tests/helpers/mocks/fetch.ts", contents: fetchHelper() },
    { path: "tests/helpers/a11y.ts", contents: a11yHelper() },
  ];
}

/**
 * npm packages the UI testing helpers import from. Init surfaces this
 * as an advisory list — we don't modify the consumer's package.json
 * directly.
 */
export function getTsUiDevDependencies(): Record<string, string> {
  return {
    "@testing-library/react": "^16.0.0",
    "@testing-library/jest-dom": "^6.0.0",
    "jest-axe": "^9.0.0",
    "@types/jest-axe": "^3.5.0",
  };
}

function renderHelper(): string {
  return `// @slowcook-one-time-scaffold UI tier-1 helper (0.7.5, cleanup wiring 0.7.16)
//
// Wraps @testing-library/react's render with the providers tier-1 UI
// tests need: mocked Next.js router, optional query client, optional
// auth state. Tests stay terse — one call covers the common setup.
// Override per test via the options object; add new provider slots
// here as the project grows (keep the options shape extensible).

import type { ReactElement } from "react";
import {
  render,
  cleanup,
  type RenderOptions,
  type RenderResult,
} from "@testing-library/react";
import { afterEach } from "vitest";

// Auto-unmount rendered components between tests. Registered at module
// load so any test file importing renderWithProviders gets cleanup
// automatically; prevents DOM state from a prior test leaking into the
// next \`getByRole(...)\` query. Without this, multiple tests in the
// same file that render the same component see each other's DOM —
// e.g., a warning banner from one test lingers into a later test that
// expects it to NOT be present. Identified by the brew agent as the
// root cause of "warning shouldn't render when X=true" style paralysis
// (slowcook 0.7.x dogfood, 2026-04-23).
afterEach(() => {
  cleanup();
});

export interface RenderWithProvidersOptions extends Omit<RenderOptions, "wrapper"> {
  /** Caller's Next.js router overrides, merged with sensible defaults. */
  router?: Partial<MockRouter>;
  /** Extra wrapping if needed (e.g., a test-only theme provider). */
  wrapper?: RenderOptions["wrapper"];
}

export interface MockRouter {
  push: (href: string) => void;
  replace: (href: string) => void;
  back: () => void;
  forward: () => void;
  refresh: () => void;
  prefetch: (href: string) => Promise<void>;
  pathname: string;
  searchParams: URLSearchParams;
}

/**
 * Default router — no-op functions, empty search params. Tests that
 * want to observe router calls pass their own \`router: { push: vi.fn() }\`.
 */
export function mockRouter(overrides: Partial<MockRouter> = {}): MockRouter {
  return {
    push: () => undefined,
    replace: () => undefined,
    back: () => undefined,
    forward: () => undefined,
    refresh: () => undefined,
    prefetch: async () => undefined,
    pathname: "/",
    searchParams: new URLSearchParams(),
    ...overrides,
  };
}

/**
 * Render a component with the standard set of providers. Returns the
 * usual @testing-library/react result plus the router instance so
 * tests can assert on navigation calls without having to re-construct
 * it.
 */
export function renderWithProviders(
  ui: ReactElement,
  options: RenderWithProvidersOptions = {}
): RenderResult & { router: MockRouter } {
  const { router: routerOverrides, wrapper, ...rest } = options;
  const router = mockRouter(routerOverrides);

  // \`next/navigation\` mocking happens in tests/setup.ts (global). This
  // helper's job is to make the router instance observable per-test.
  // If tests/setup.ts hasn't been wired yet, see context.md for the
  // required setup file pattern.

  const result = render(ui, { ...rest, wrapper });
  return { ...result, router };
}
`;
}

function fetchHelper(): string {
  return `// @slowcook-one-time-scaffold UI tier-1 helper (0.7.5)
//
// Stand-in for the global \`fetch\` that tier-1 UI tests need. Mirrors
// the mockSupabase / realShapedCreateClient pattern: tests pass intent
// ("these routes, these responses"), and \`realShapedFetch\` wraps the
// mock to assert invocation shape — catching the class of bug where
// handler code calls fetch with the wrong args shape and tests pass
// because the mock ignores everything.

import { vi } from "vitest";

export interface MockFetchRoute {
  /** URL match — either literal substring or a regex. */
  url: string | RegExp;
  /** HTTP method to match (default: any). */
  method?: string;
  /** Response body to return. JSON objects are serialized automatically. */
  body?: unknown;
  /** HTTP status (default: 200). */
  status?: number;
  /** Extra response headers. */
  headers?: Record<string, string>;
}

export interface MockFetchConfig {
  routes?: MockFetchRoute[];
  /** Default response when no route matches. Omit to throw on unmatched. */
  fallback?: { status: number; body?: unknown };
}

export interface MockFetchClient {
  fn: ReturnType<typeof vi.fn>;
  /** Every recorded call. Handy for assertion. */
  calls: Array<{ url: string; method: string; body: unknown }>;
}

export function mockFetch(config: MockFetchConfig = {}): MockFetchClient {
  const calls: MockFetchClient["calls"] = [];
  const routes = config.routes ?? [];

  const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = (init?.method ?? "GET").toUpperCase();
    const body = init?.body ? safeParseBody(init.body) : undefined;
    calls.push({ url, method, body });

    for (const route of routes) {
      if (route.method && route.method.toUpperCase() !== method) continue;
      const urlMatches =
        route.url instanceof RegExp ? route.url.test(url) : url.includes(route.url);
      if (!urlMatches) continue;
      return buildResponse(route);
    }

    if (config.fallback) {
      return new Response(
        typeof config.fallback.body === "string"
          ? config.fallback.body
          : JSON.stringify(config.fallback.body ?? {}),
        { status: config.fallback.status, headers: { "Content-Type": "application/json" } }
      );
    }

    throw new Error(
      \`mockFetch: no route matched \${method} \${url}. Routes configured: \${routes.length}. Pass a \\\`fallback\\\` in MockFetchConfig to suppress this error.\`
    );
  });

  return { fn, calls };
}

/**
 * Signature-asserting wrapper. Prefer this over passing \`client.fn\`
 * directly to \`vi.stubGlobal("fetch", ...)\` — catches handler code
 * that calls fetch with a wrong-shaped first argument (e.g. forgetting
 * to stringify a URL object, or passing an options bag by mistake).
 * Tests would pass without this (mock ignores unknown args) but
 * production would crash.
 */
export function realShapedFetch(
  client: MockFetchClient
): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (
      typeof input !== "string" &&
      !(input instanceof URL) &&
      !(typeof input === "object" && input !== null && "url" in input)
    ) {
      throw new Error(
        \`realShapedFetch: first arg must be a string, URL, or Request; got \${typeof input}. This likely means the handler called fetch() without a URL or passed the options as the first arg.\`
      );
    }
    return client.fn(input, init);
  }) as typeof fetch;
}

function buildResponse(route: MockFetchRoute): Response {
  const status = route.status ?? 200;
  const headers = {
    "Content-Type": "application/json",
    ...(route.headers ?? {}),
  };
  const body =
    typeof route.body === "string"
      ? route.body
      : JSON.stringify(route.body ?? {});
  return new Response(body, { status, headers });
}

function safeParseBody(body: BodyInit | null): unknown {
  if (typeof body !== "string") return body;
  try {
    return JSON.parse(body);
  } catch {
    return body;
  }
}
`;
}

function a11yHelper(): string {
  return `// @slowcook-one-time-scaffold UI tier-1 helper (0.7.5, jest-dom wiring 0.7.11)
//
// Centralises UI testing matchers so individual tests don't re-wire
// per-file. Importing this file (via the tier-1 UI test's import of
// \`axe\`) extends vitest's \`expect\` with:
//
//   - jest-axe's \`toHaveNoViolations\` — accessibility audits.
//   - @testing-library/jest-dom's full matcher set —
//     toBeInTheDocument, toHaveTextContent, toHaveClass, toBeDisabled,
//     toBeVisible, toHaveAccessibleName, and ~30 others. Without this
//     import, tests that use those matchers fail with a misleading
//     "Invalid Chai property: toBeInTheDocument" error.
//
// 0.7.11 backstory: the jest-dom import was missing in 0.7.5 Phase A.
// First UI brew run during dogfood (~\$3.39 spent) halted in agent
// analysis-paralysis because 16 tests failed with the misleading Chai
// error — agent read "alert test fails" as "my code renders an alert
// wrongly" and couldn't reconcile. Adding this import makes all the
// standard DOM matchers work; brew runs can see real signal.

// Side-effect import — auto-extends vitest's \`expect\` with jest-dom
// matchers + registers TypeScript augmentations so tests type-check
// without per-file /// <reference> directives.
import "@testing-library/jest-dom/vitest";

import { axe as axeCore, toHaveNoViolations } from "jest-axe";
import { expect } from "vitest";

expect.extend(toHaveNoViolations);

/**
 * Thin re-export of \`jest-axe\`'s axe(). Runs a11y audits against a
 * rendered DOM container and returns a result compatible with
 * \`expect(result).toHaveNoViolations()\`.
 *
 * Usage:
 *   const { container } = renderWithProviders(<ProfileEditForm .../>);
 *   expect(await axe(container)).toHaveNoViolations();
 */
export const axe = axeCore;

// TypeScript augmentation so .toHaveNoViolations() type-checks without
// per-test \`/// <reference>\` directives.
declare module "vitest" {
  interface Assertion<T = unknown> {
    toHaveNoViolations(): T;
  }
  interface AsymmetricMatchersContaining {
    toHaveNoViolations(): unknown;
  }
}
`;
}

/** Stable identifier for this stack. */
export const STACK_ID = "typescript" as const;
