"use client";

import { useSearchParams } from "next/navigation";
import { useScenarioRegistry } from "./registry-context.js";
import { resolveScenario } from "./scenarios.js";
import type { Scenario } from "./types.js";

/**
 * Read the active scenario for the current request.
 *
 * Resolves from:
 *   1. `?scenario=<id>` query param
 *   2. `MOCK_SCENARIO` env var (server-side; reaches the client via
 *      hydration of the registry's default if env was set at build time)
 *   3. Registry's first-registered fallback
 *
 * Returns `null` only when the registry is empty AND no fallback exists.
 * Components rendering scenario data should guard with an empty-state.
 */
export function useScenario(): Scenario | null {
  const registry = useScenarioRegistry();
  const params = useSearchParams();
  const id = params?.get("scenario") ?? null;
  return resolveScenario(registry, id);
}

/**
 * Typed accessor for a particular fixture domain. Throws a clear error
 * (in dev) when the active scenario doesn't provide that domain — far
 * better signal than `undefined` coming back silently.
 *
 * ```tsx
 * const pins = useScenarioFixture<Pin[]>("pins");
 * ```
 */
export function useScenarioFixture<T>(domain: string): T {
  const scenario = useScenario();
  if (!scenario) {
    throw new Error(
      `useScenarioFixture("${domain}"): no scenario resolved. The mock has no scenarios registered yet — add one in mock/scenarios/.`
    );
  }
  const data = scenario.fixtures[domain];
  if (data === undefined) {
    throw new Error(
      `useScenarioFixture("${domain}"): scenario "${scenario.id}" does not provide fixtures for that domain. Available: ${Object.keys(scenario.fixtures).join(", ") || "(none)"}`
    );
  }
  return data as T;
}
