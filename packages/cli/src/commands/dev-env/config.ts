/**
 * `.brewing/dev-env.yaml` config schema — Phase 2 of the dev-env
 * upstreaming (delgoosh-first proof in Phase 1, generalised here).
 *
 * Consumers describe their dev env once: which apps run, in what
 * mode (hot-reload vs production-shaped), which git branch the env
 * mirrors (default `dev`), how seed data flows, and the optional SSH
 * target if the env runs on a remote box.
 *
 * Then `slowcook dev-env <subcmd>` reads the file and acts. Today
 * this Phase 2 cut ships only `push` end-to-end (the load-bearing
 * operation for Phase 3 brew/plate wiring); `up`, `sync`, `switch`,
 * `reset` ship as stubs that emit the canonical command shell for
 * the consumer to wire into their workflow.
 */

import { z } from "zod";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";

export const DEV_ENV_CONFIG_PATH = ".brewing/dev-env.yaml";

const AppModeSchema = z.enum([
  "dev", // Next dev (hot reload) — for apps under active story development
  "start", // next build + next start — production-shaped, slower restart
  "nest-watch", // ts-node-dev / nest start --watch — backend hot reload
  "static", // serve a built static export, never re-run
  "none", // entry exists but isn't started by `dev-env up` (e.g. cron)
]);

const AppSchema = z.object({
  mode: AppModeSchema,
  port: z.number().int().positive(),
  /** Restart on crash. Defaults to true. */
  autoheal: z.boolean().optional().default(true),
  /** Optional: explicit container/process name override (otherwise the key). */
  container: z.string().optional(),
});

const PersistenceSchema = z.object({
  /**
   * Named docker volume that survives `dev-env reset`. PM-added DB
   * rows persist across redeploys; only the seed-owned rows are
   * touched by reset.
   */
  db_volume: z.string().optional(),
  /** Named volume for uploaded user files / object storage. */
  uploads_volume: z.string().optional(),
});

const SshTargetSchema = z.object({
  host: z.string(),
  user: z.string(),
  /** Absolute path on the box where the consumer's checkout lives. */
  checkout_dir: z.string(),
  /** Repo secret name holding the SSH private key. */
  key_secret: z.string().default("DEV_DEPLOY_SSH_KEY"),
});

export const DevEnvConfigSchema = z.object({
  $schema: z.string().optional(),
  schema_version: z.literal(1),
  /**
   * The git branch the dev env always reads from. Force-pushable —
   * agents shove story-branch heads here to preview them. Default:
   * `dev`.
   */
  source_branch: z.string().default("dev"),
  /**
   * Path (repo-relative) to the seed script. Run by `dev-env up` and
   * `dev-env reset`. Must be idempotent on already-seeded data.
   */
  seed_script: z.string().optional(),
  /**
   * Where the dev env physically runs. Omit for "local docker compose
   * on the runner" semantics (rare); set for SSH-to-box deploys.
   */
  ssh_target: SshTargetSchema.optional(),
  persistence: PersistenceSchema.optional().default({}),
  apps: z.record(z.string(), AppSchema),
});

export type DevEnvConfig = z.infer<typeof DevEnvConfigSchema>;
export type AppMode = z.infer<typeof AppModeSchema>;

export function loadDevEnvConfig(repoRoot: string): DevEnvConfig {
  const path = join(repoRoot, DEV_ENV_CONFIG_PATH);
  if (!existsSync(path)) {
    throw new Error(
      `${DEV_ENV_CONFIG_PATH} not found. Run \`slowcook dev-env init\` to scaffold.`,
    );
  }
  let raw: unknown;
  try {
    raw = YAML.parse(readFileSync(path, "utf8"));
  } catch (e) {
    throw new Error(
      `${DEV_ENV_CONFIG_PATH} is not valid YAML: ${(e as Error).message}`,
    );
  }
  const parsed = DevEnvConfigSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(
      `${DEV_ENV_CONFIG_PATH} failed validation: ${parsed.error.issues
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; ")}`,
    );
  }
  return parsed.data;
}
