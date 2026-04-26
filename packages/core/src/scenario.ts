/**
 * 0.13.0 (paired with 0.16.0-α.2 of the cli) — public Scenario types
 * for the slowcook mock-app pipeline.
 *
 * Lives in core (not mock-runtime) so agents that need to reason about
 * scenarios — vibe (writes them), plate (amends them), brew (reads them
 * for fixture shapes when wiring real data) — don't pull React + Next
 * peer deps just to use the types. mock-runtime re-exports these so
 * consumer-side code can import from `@slowcook-ai/mock-runtime` and
 * stay agnostic to which package owns the types.
 *
 * Architecture notes:
 *  - The mock app is UI-only. Scenarios are plain TypeScript modules;
 *    React hooks read them; mutations are local component state.
 *  - The mock is singular per consumer + grows incrementally per story.
 *  - Brew copies mock components → src/ + adds real-data wiring;
 *    scenarios stay in mock/ as the design contract.
 *
 * See `docs/plans/0.16-mock-app.md`.
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
 * `defineScenarios([scenario1, scenario2, ...])` from mock-runtime
 * and passed to `<ScenarioRegistryProvider>` at the layout level.
 *
 * The runtime exports a builder that returns this shape; agents that
 * read scenarios (vibe, plate, brew) construct it the same way for
 * unit-test purposes.
 */
export interface ScenarioRegistry {
  byId: Record<string, Scenario>;
  list: Scenario[];
  /** First-registered fallback when no scenario is resolved. */
  default: Scenario | null;
}
