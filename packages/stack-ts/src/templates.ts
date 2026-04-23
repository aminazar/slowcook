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
  return ["vitest.config.ts", "vitest.config.mjs", "vitest.config.js"];
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
  return `// @slowcook-one-time-scaffold UI tier-1 helper (0.7.5)
//
// Wraps @testing-library/react's render with the providers tier-1 UI
// tests need: mocked Next.js router, optional query client, optional
// auth state. Tests stay terse — one call covers the common setup.
// Override per test via the options object; add new provider slots
// here as the project grows (keep the options shape extensible).

import type { ReactElement } from "react";
import { render, type RenderOptions, type RenderResult } from "@testing-library/react";

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
  return `// @slowcook-one-time-scaffold UI tier-1 helper (0.7.5)
//
// Centralises the \`jest-axe\` setup so individual tests don't re-wire
// the matcher per-file. Import \`axe\` for the runner and use the
// \`toHaveNoViolations\` matcher that's been installed globally here.

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
