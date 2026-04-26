import type { Scenario, ScenarioRegistry } from "./types.js";

/**
 * Build a `ScenarioRegistry` from a list of scenarios.
 *
 * Validates that ids are unique; throws on collision (catches the
 * common copy-paste-without-rename mistake when adding a new scenario).
 *
 * Consumer's `mock/src/lib/scenario-registry.ts` looks like:
 *
 * ```ts
 * import { defineScenarios } from "@slowcook-ai/mock-runtime";
 * import story017 from "../../scenarios/story-017.js";
 * import story020 from "../../scenarios/story-020.js";
 *
 * export const registry = defineScenarios([story017, story020]);
 * ```
 *
 * Vibe extends this list when it adds a new scenario (one new import
 * line + one new array entry).
 */
export function defineScenarios(scenarios: Scenario[]): ScenarioRegistry {
  const byId: Record<string, Scenario> = {};
  for (const s of scenarios) {
    if (byId[s.id] !== undefined) {
      throw new Error(
        `defineScenarios: duplicate scenario id "${s.id}". Each scenario file must export a unique id.`
      );
    }
    byId[s.id] = s;
  }
  return {
    byId,
    list: scenarios,
    default: scenarios[0] ?? null,
  };
}

/**
 * Resolve which scenario should render for a given query-param value
 * + env var (for SSR / docker-pinned previews).
 *
 * Resolution order:
 *   1. The query-param `scenario` value (if it matches a registered id)
 *   2. The `MOCK_SCENARIO` env var (server-side only — process.env)
 *   3. The registry's `default` (first registered)
 *   4. `null` (registry empty)
 *
 * Pure function; safe to call from server or client.
 */
export function resolveScenario(
  registry: ScenarioRegistry,
  queryParamValue: string | null | undefined
): Scenario | null {
  if (queryParamValue && registry.byId[queryParamValue]) {
    return registry.byId[queryParamValue]!;
  }
  // env-var fallback (server only — typeof process check for browser safety)
  if (typeof process !== "undefined" && process.env && process.env["MOCK_SCENARIO"]) {
    const envId = process.env["MOCK_SCENARIO"];
    if (registry.byId[envId]) {
      return registry.byId[envId]!;
    }
  }
  return registry.default;
}
