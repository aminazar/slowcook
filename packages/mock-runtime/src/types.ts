/**
 * Public types for the mock runtime.
 *
 * A `Scenario` is the per-story input that drives the mock app's
 * state — which user is "logged in", what fixture data exists, which
 * path to land on, what interactions a PM should test.
 *
 * Vibe writes one of these per story under `mock/scenarios/story-N.ts`
 * and registers it in the consumer-owned `mock/src/lib/scenario-registry.ts`.
 * Plate amends them in response to PM feedback.
 *
 * Important: the mock app is UI-only. There is NO Supabase. There is
 * NO backend. Scenarios are plain TypeScript modules that React hooks
 * read at render time. Mutations are local component state — they
 * reset on page reload, which is the right behaviour for a mockup
 * (PM either keeps clicking or refreshes to start over).
 */

export interface MockUser {
  id: string;
  email?: string;
  handle: string;
  display_name: string;
  avatar_url?: string | null;
  bio?: string | null;
}

export interface Scenario {
  /** Story id this scenario exercises (e.g. "017"). */
  id: string;
  /** Human label shown in the scenario picker. */
  name: string;
  /**
   * The "logged in" user for this scenario. Mock components that ask
   * "who's the viewer?" via `useScenario().user` get this back.
   * Pass `null` for anonymous-visitor scenarios.
   */
  user: MockUser | null;
  /**
   * Initial path the mock app navigates to. Use the production route
   * shape (e.g. "/u/amin", not "/u/[handle]"). The scenario picker
   * `Link`s here on selection.
   */
  initialPath: string;
  /**
   * Free-form fixture data. Components that need scenario data call
   * `useScenarioFixture<T>(domain)` to read it.
   *
   * Convention: organise by domain (`pins`, `reactions`, `bookmarks`)
   * so multiple scenarios for the same area share field shapes.
   */
  fixtures: Record<string, unknown>;
  /**
   * Optional: prose list of interactions PM should validate. Surfaced
   * in the scenario picker UI so reviewers know what to click through.
   */
  expectedInteractions?: string[];
}

/**
 * A registry of scenarios, keyed by id. Built by the consumer via
 * `defineScenarios([scenario1, scenario2, ...])` (see scenarios.ts)
 * and passed to `<ScenarioRegistryProvider>` at the layout level.
 */
export interface ScenarioRegistry {
  byId: Record<string, Scenario>;
  list: Scenario[];
  /** First-registered fallback when no scenario is resolved. */
  default: Scenario | null;
}
