/**
 * Public types for the mock runtime — re-exported from
 * `@slowcook-ai/core` (where they live since 0.13.0) so consumer-side
 * code can import from `@slowcook-ai/mock-runtime` without knowing
 * about the core package.
 *
 * The types own their JSDoc in core/src/scenario.ts; this file is
 * intentionally thin. Agent code (vibe / plate / brew) imports from
 * core directly to avoid pulling React peer deps.
 */

export type {
  MockUser,
  Scenario,
  ScenarioRegistry,
} from "@slowcook-ai/core";
