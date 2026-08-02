/**
 * `.brewing/dev-env.yaml` (legacy) and `.brewing/serve.yaml` (new) —
 * profile-aware config for `slowcook serve <profile> <verb>`.
 *
 * Trade-off resolution from `docs/plans/0.20-design-discussions.md`
 * design #5: KEEP the `dev-env.yaml` filename forever. The schema
 * grows a `profiles:` map for multi-profile use; legacy flat shape
 * (no `profiles:` key) is wrapped as `profiles.dev = {...flat}` on
 * load. Migration cost for existing consumers: zero.
 *
 * Phase 1 (this cut): only the `dev` profile is consumed by
 * `slowcook serve dev up|sync|down|logs`. `mock` and `staging`
 * profiles parse into the same shape but are stubs until Phase 2 + 3.
 */

import { z } from "zod";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";

export const DEV_ENV_CONFIG_PATH = ".brewing/dev-env.yaml";
export const SERVE_CONFIG_PATH = ".brewing/serve.yaml";

const AppModeSchema = z.enum([
  "dev",         // Next dev (hot reload) — for apps under active story development
  "start",       // next build + next start — production-shaped, slower restart
  "nest-watch",  // ts-node-dev / nest start --watch — backend hot reload
  "nest-prod",   // nest start (built) — built-image staging
  "next-dev",    // explicit alias for "dev" used by the design doc
  "next-start",  // explicit alias for "start"
  "vite-dev",    // vite dev (mock profile)
  "static",      // serve a built static export, never re-run
  "none",        // entry exists but isn't started by `serve` (e.g. cron)
]);

const AppSchema = z.object({
  mode: AppModeSchema,
  port: z.number().int().positive(),
  /** Restart on crash. Defaults to true. */
  autoheal: z.boolean().optional().default(true),
  /** Optional: explicit container/process name override (otherwise the key). */
  container: z.string().optional(),
  /**
   * Deep-health probe path for `serve <profile> watchdog`. Must exercise
   * the dev server's TRANSFORM pipeline, not just static serving: a wedged
   * vite/next dev server keeps answering `/` with index.html 200 while
   * every module request hangs (the delgoosh blank-portal incident,
   * 2026-08-02 — HMR storm → mid-flood self-restart → all modules 504
   * behind the proxy, container "healthy" throughout). For vite apps the
   * entry module is the right probe: `probe_path: /src/main.tsx`.
   * Apps without a probe_path are not watched.
   */
  probe_path: z.string().optional(),
  /** Seconds between probe rounds. */
  probe_interval_s: z.number().int().positive().optional().default(30),
  /** Per-probe timeout — wedged transforms hang far longer than this. */
  probe_timeout_s: z.number().int().positive().optional().default(10),
  /** Consecutive failures before recovery (rides out a single blip). */
  probe_strikes: z.number().int().positive().optional().default(2),
  /**
   * Paths (relative to the checkout) removed before each recovery restart —
   * for vite apps the pre-bundle cache, e.g.
   * `[apps/web/node_modules/.vite]`. A wedge that survives a plain restart
   * has always cleared with cache-removal + restart.
   */
  recover_clear: z.array(z.string()).optional().default([]),
  /**
   * How many clear+restart cycles one recovery performs. Default 2: the
   * first boot after a wedge re-optimizes against a browser-poisoned
   * module graph and has come back wedged; the second boot from a clean
   * cache is the state that stays healthy.
   */
  recover_restarts: z.number().int().positive().optional().default(2),
  /** Seconds the app is left alone after a recovery (no restart loops). */
  recover_cooldown_s: z.number().int().positive().optional().default(300),
});

const PersistenceSchema = z.object({
  /**
   * Named docker volume that survives `serve <profile> reset`. PM-added
   * DB rows persist across redeploys; only the seed-owned rows are
   * touched by reset (only meaningful for the `staging` profile).
   */
  db_volume: z.string().optional(),
  uploads_volume: z.string().optional(),
});

const SshTargetSchema = z.object({
  host: z.string(),
  user: z.string(),
  /** Absolute path on the box where the consumer's checkout lives. */
  checkout_dir: z.string(),
  /** Repo-secret name holding the SSH private key. */
  key_secret: z.string().default("DEV_DEPLOY_SSH_KEY"),
});

/**
 * Staging-only: named seed scenarios (Trade-off #5 — map shape from day 1).
 *
 *   seed:
 *     scenarios:
 *       demo:
 *         scripts: ["packages/seeds/demo/*.ts"]
 *       enterprise:
 *         scripts: ["packages/seeds/enterprise/*.ts"]
 *     guard_env: STAGING_RESET_ALLOWED
 */
const SeedScenarioSchema = z.object({
  scripts: z.array(z.string()).default([]),
});
const SeedSchema = z.object({
  scenarios: z.record(z.string(), SeedScenarioSchema).default({}),
  guard_env: z.string().optional(),
});

/** Profile mode controls how `serve <profile> sync` ships code to the box. */
const ProfileModeSchema = z.enum([
  "bind-mount-source", // rsync source + anonymous-volume node_modules (dev, mock)
  "built-image",       // consumer's bring-up script runs an image pull (staging)
]);

export const ProfileConfigSchema = z.object({
  /** How sync delivers code to the runtime. Defaults to `bind-mount-source`. */
  mode: ProfileModeSchema.optional().default("bind-mount-source"),
  /** Git branch the profile tracks. Default: `dev`. */
  source_branch: z.string().default("dev"),
  /**
   * One or more compose files passed as `-f <path>` in declared order.
   * The canonical pattern for `bind-mount-source` profiles:
   *
   *   compose_files:
   *     - docker-compose.production.yml   # base: postgres, networks, depends_on chain
   *     - docker-compose.dev.yml          # overlay: bind-mount overrides
   *
   * Real consumers (delgoosh, etc.) define their long-lived services
   * (postgres / temporal / non-swapped apps) in a base compose and the
   * dev/staging overlays ONLY redefine the services that swap. Emitting
   * just `-f overlay.yml` skips the base, breaking `depends_on`.
   *
   * Takes precedence over `compose_overlay` if both are set. Reported
   * as a dogfood gap on serve 0.19.6 (sc#173 finding #2).
   */
  compose_files: z.array(z.string()).optional(),
  /** Single compose-overlay path (legacy). Use `compose_files` for base+overlay layering. */
  compose_overlay: z.string().optional(),
  /**
   * Built-image profiles call into the consumer's bring-up script
   * (Trade-off #3 — slowcook ships zero image-build pipeline).
   * If unset, slowcook falls back to `docker compose -f compose_overlay up -d`.
   */
  bringup_cmd: z.string().optional(),
  apps: z.record(z.string(), AppSchema).default({}),
  persistence: PersistenceSchema.optional().default({}),
  /** Optional: SSH target the profile uses. If absent, profile runs locally. */
  ssh_target: SshTargetSchema.optional(),
  /** Single-script legacy seed (dev/mock profiles); staging uses `seed.scenarios`. */
  seed_script: z.string().optional(),
  /** Staging-only seed scenarios map. */
  seed: SeedSchema.optional(),
});

export type ProfileConfig = z.infer<typeof ProfileConfigSchema>;
export type AppMode = z.infer<typeof AppModeSchema>;

/**
 * Normalised shape after loading EITHER `.brewing/serve.yaml`
 * (explicit `profiles:` key) OR `.brewing/dev-env.yaml` (legacy flat
 * shape — wrapped as `{profiles: {dev: {...flat}}}`).
 */
export const ServeConfigSchema = z.object({
  $schema: z.string().optional(),
  schema_version: z.literal(1),
  profiles: z.record(z.string(), ProfileConfigSchema),
});

export type ServeConfig = z.infer<typeof ServeConfigSchema>;

/**
 * Loader: prefer `.brewing/serve.yaml` if present, else fall back to
 * `.brewing/dev-env.yaml`. Legacy flat shapes get wrapped to the
 * `{profiles: {dev: {...flat}}}` form. Returns the normalised
 * `ServeConfig`.
 */
export function loadServeConfig(repoRoot: string): ServeConfig {
  const servePath = join(repoRoot, SERVE_CONFIG_PATH);
  const devEnvPath = join(repoRoot, DEV_ENV_CONFIG_PATH);
  const chosen = existsSync(servePath) ? servePath : existsSync(devEnvPath) ? devEnvPath : null;
  if (!chosen) {
    throw new Error(
      `Neither ${SERVE_CONFIG_PATH} nor ${DEV_ENV_CONFIG_PATH} found. Run \`slowcook serve init\` to scaffold (Phase 1 — coming soon) or hand-author either path.`,
    );
  }
  let raw: unknown;
  try {
    raw = YAML.parse(readFileSync(chosen, "utf8"));
  } catch (e) {
    throw new Error(`${chosen} is not valid YAML: ${(e as Error).message}`);
  }
  return normaliseConfig(raw, chosen);
}

/**
 * Detect legacy vs new shape + normalise. Exported for tests + the
 * legacy `slowcook dev-env` callers that want the same loader.
 */
export function normaliseConfig(raw: unknown, source: string): ServeConfig {
  if (typeof raw !== "object" || raw === null) {
    throw new Error(`${source}: expected a YAML object at the top level.`);
  }
  const obj = raw as Record<string, unknown>;

  // New shape: explicit `profiles:` key.
  if (obj["profiles"] && typeof obj["profiles"] === "object") {
    const parsed = ServeConfigSchema.safeParse(obj);
    if (!parsed.success) {
      throw new Error(formatZodError(source, parsed.error));
    }
    return parsed.data;
  }

  // Legacy shape: flat top-level → wrap as `profiles.dev`.
  const { schema_version, $schema, ...flat } = obj;
  const wrapped = {
    $schema,
    schema_version,
    profiles: { dev: flat },
  };
  const parsed = ServeConfigSchema.safeParse(wrapped);
  if (!parsed.success) {
    throw new Error(formatZodError(source, parsed.error));
  }
  return parsed.data;
}

function formatZodError(source: string, err: z.ZodError): string {
  const issues = err.issues
    .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
    .join("; ");
  return `${source} failed validation: ${issues}`;
}

/** Convenience: lookup a profile by name (case-sensitive). */
export function getProfile(config: ServeConfig, name: string): ProfileConfig | undefined {
  return config.profiles[name];
}

/**
 * Return the ordered list of compose files for `docker compose -f ... -f ...`.
 * Prefers `compose_files` (the multi-file shape sc#173 #2 surfaced); falls
 * back to `compose_overlay` (legacy single-file). Empty when neither is set.
 */
export function composeFiles(profile: ProfileConfig): string[] {
  if (profile.compose_files && profile.compose_files.length > 0) return profile.compose_files;
  if (profile.compose_overlay) return [profile.compose_overlay];
  return [];
}

/**
 * Whether `docker compose up` should pass `--build`.
 *
 * - `bind-mount-source`: NEVER. The whole point of the mode is to skip
 *   docker build (rsync source into a bind-mounted container). Passing
 *   `--build` triggers a rebuild that takes minutes per up. sc#173 #2.
 * - `built-image`: usually no — the consumer's bring-up rebuilds out of
 *   band. But the explicit `--build` from `up` is conventional for
 *   built-image so the local docker daemon picks up image edits.
 */
export function shouldBuildOnUp(profile: ProfileConfig): boolean {
  return profile.mode === "built-image";
}
