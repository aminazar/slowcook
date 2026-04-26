/**
 * @slowcook-ai/mock-runtime — runtime for slowcook's mock app
 *
 * The mock app is a per-consumer, singular UI mockup that vibe + plate
 * evolve over time. Brew copies its components into production with
 * real-data wiring. This package owns the runtime — Scenario types,
 * registry, React hooks, default homepage UI — so consumers don't
 * hand-author scaffolding.
 *
 * Consumers get the consumer-side shell (package.json, Dockerfile,
 * layout.tsx, etc.) via `slowcook init mock`.
 *
 * See `docs/plans/0.16-mock-app.md` on the slowcook repo.
 */

export type {
  MockUser,
  Scenario,
  ScenarioRegistry,
} from "./types.js";

export { defineScenarios, resolveScenario } from "./scenarios.js";

export {
  ScenarioRegistryContext,
  ScenarioRegistryProvider,
  useScenarioRegistry,
  type ScenarioRegistryProviderProps,
} from "./registry-context.js";

export { useScenario, useScenarioFixture } from "./use-scenario.js";

export { ScenarioPicker } from "./scenario-picker.js";
