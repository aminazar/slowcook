/**
 * Testing-surface router model (review-overlay 0.9.0).
 *
 * A consumer's mock can expose a `testing-surfaces.json` manifest describing how
 * to reach every UI state of every surface in ≤4 clicks:
 *   EPIC ▸ CONTEXT ▸ SCENARIO ▸ STATE ▸ CTA.
 *
 *  - epic    = a slice of the product (e.g. "payment"); the mock loads one at a
 *              time. Base surfaces are always present; PSS + mock data swap.
 *  - context = an auth/IDENTITY context (generalises "persona"): `status`
 *              'anonymous' (no user — login/signup surfaces are first-class) or
 *              'authed' (carries `user`).
 *  - scenario= a multi-step journey on a surface.
 *  - state   = a checkpoint. `hard` states are direct-injected; a state's
 *              `becomes` flips the active context (login as OUTCOME).
 *
 * The overlay RENDERS the router and WRITES the resolved selection to
 * localStorage (key below). The consumer's data-adaptor READS that selection
 * synchronously to swap the authed user + fixtures + seed. `seed` is the
 * consumer's own shape; the overlay only resolves two documented conventions:
 * `profileIds` (→ full objects via the epic `profiles` lookup, with
 * `profileOverrides`) and `dateOffsetDays` (→ ISO, so mock dates never go
 * stale). Everything else in `seed` passes through opaque.
 */

export interface ManifestState {
  id: string;
  label: string;
  hard?: boolean;
  cta?: string;
  advancesTo?: string;
  seed?: Record<string, unknown>;
  fixtures?: Record<string, unknown>;
  /** Login-as-outcome: applying this state flips the active context. */
  becomes?: { context: string; route?: string };
}
export interface ManifestScenario { id: string; label: string; route: string; states: ManifestState[]; }
export interface ManifestContext {
  id: string;
  label: string;
  group?: string;
  base: string;
  status: "anonymous" | "authed";
  user?: Record<string, unknown>;
  scenarios: ManifestScenario[];
}
export interface Epic {
  id: string;
  label: string;
  profiles?: Record<string, Record<string, unknown>>;
  contexts: ManifestContext[];
}
export interface Manifest { activeEpicDefault?: string; epics: Epic[]; }

const EMPTY: Manifest = { epics: [] };

const cache = new Map<string, Promise<Manifest>>();
/** Fetch + cache the manifest from `url`. */
export function loadManifest(url: string): Promise<Manifest> {
  const hit = cache.get(url);
  if (hit) return hit;
  const p = fetch(url, { cache: "no-store" })
    .then((r) => (r.ok ? r.json() : EMPTY))
    .then((j) => (j && Array.isArray((j as Manifest).epics) ? (j as Manifest) : EMPTY))
    .catch(() => EMPTY);
  cache.set(url, p);
  return p;
}

/** Active epic id: ?epic= URL param → activeEpicDefault → first epic. */
export function activeEpicId(m: Manifest): string {
  let param: string | null = null;
  try { param = new URLSearchParams(window.location.search).get("epic"); } catch { /* ssr */ }
  if (param && m.epics.some((e) => e.id === param)) return param;
  if (m.activeEpicDefault && m.epics.some((e) => e.id === m.activeEpicDefault)) return m.activeEpicDefault;
  return m.epics[0]?.id ?? "";
}

const DAY = 24 * 3600 * 1000;
/** Resolve a seed: `profileIds` → objects (via epic `profiles` + overrides), `dateOffsetDays` → ISO. */
export function resolveSeed(
  raw: Record<string, unknown> | undefined,
  profiles: Record<string, Record<string, unknown>>,
): Record<string, unknown> {
  if (!raw) return {};
  const out: Record<string, unknown> = { ...raw };
  const ids = raw.profileIds as string[] | undefined;
  if (ids) {
    const ov = (raw.profileOverrides as Record<string, Record<string, unknown>> | undefined) ?? {};
    out.profiles = ids.map((id) => ({ ...(profiles[id] ?? {}), ...(ov[id] ?? {}) }));
    delete out.profileIds;
    delete out.profileOverrides;
  }
  const now = Date.now();
  const up = raw.upcoming as Array<Record<string, unknown>> | undefined;
  if (Array.isArray(up)) out.upcoming = up.map((u) => ({ ...u, dateISO: new Date(now + Number(u.dateOffsetDays ?? 0) * DAY).toISOString() }));
  const txs = raw.transactions as Array<Record<string, unknown>> | undefined;
  if (Array.isArray(txs)) out.transactions = txs.map((t) => ({ ...t, date: new Date(now + Number(t.dateOffsetDays ?? 0) * DAY).toISOString() }));
  return out;
}

export interface ResolvedSelection {
  epicId: string; contextId: string; scenarioId: string; stateId: string;
  status: "anonymous" | "authed";
  route: string; base: string; label: string;
  user: Record<string, unknown> | null;
  seed: Record<string, unknown>;
  fixtures: Record<string, unknown>;
}
export const SURFACE_SELECTION_KEY = "slowcook_test_surface";
export const SURFACE_SELECTION_EVENT = "slowcook-test-surface-change";

export function getSelection(): ResolvedSelection | null {
  try {
    const raw = typeof localStorage !== "undefined" ? localStorage.getItem(SURFACE_SELECTION_KEY) : null;
    if (!raw) return null;
    const s = JSON.parse(raw) as ResolvedSelection;
    return s && s.contextId && s.stateId ? s : null;
  } catch {
    return null;
  }
}

/** Pure resolver — manifest + ids → the selection to persist + the target URL (handles `becomes`). */
export function resolveSelection(
  m: Manifest, epicId: string, contextId: string, scenarioId: string, stateId: string,
): { selection: ResolvedSelection; url: string } | null {
  const epic = m.epics.find((e) => e.id === epicId);
  const context = epic?.contexts.find((c) => c.id === contextId);
  const scenario = context?.scenarios.find((s) => s.id === scenarioId);
  const state = scenario?.states.find((s) => s.id === stateId);
  if (!epic || !context || !scenario || !state) return null;
  const profiles = epic.profiles ?? {};
  const short = (s: string): string => s.split(" · ")[0]!;

  if (state.becomes) {
    const target = epic.contexts.find((c) => c.id === state.becomes!.context);
    if (target) {
      const route = state.becomes.route ?? target.scenarios[0]?.route ?? scenario.route;
      return {
        selection: {
          epicId, contextId: target.id, scenarioId: "", stateId: "",
          status: "authed", route, base: target.base,
          label: `${short(context.label)} → ${short(target.label)}`,
          user: target.user ?? null, seed: {}, fixtures: {},
        },
        url: `${target.base.replace(/\/$/, "")}${route}`,
      };
    }
  }
  return {
    selection: {
      epicId, contextId, scenarioId, stateId,
      status: context.status, route: scenario.route, base: context.base,
      label: `${short(context.label)} › ${scenario.label} › ${state.label}`,
      user: context.status === "authed" ? (context.user ?? null) : null,
      seed: resolveSeed(state.seed, profiles),
      fixtures: (state.fixtures as Record<string, unknown> | undefined) ?? {},
    },
    url: `${context.base.replace(/\/$/, "")}${scenario.route}`,
  };
}

/** Resolve + persist + return the nav URL. */
export function applySelection(
  m: Manifest, epicId: string, contextId: string, scenarioId: string, stateId: string,
): string | null {
  const r = resolveSelection(m, epicId, contextId, scenarioId, stateId);
  if (!r) return null;
  try {
    localStorage.setItem(SURFACE_SELECTION_KEY, JSON.stringify(r.selection));
    window.dispatchEvent(new CustomEvent(SURFACE_SELECTION_EVENT));
  } catch { /* storage disabled */ }
  return r.url;
}
