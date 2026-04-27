/**
 * `.brewing/preview.yaml` schema + parser — 0.16.0-α.5.
 *
 * Lightweight config that tells `slowcook preview deploy/teardown` how
 * to ssh into the consumer's box, where to put files, what port range
 * to allocate from, and what URL pattern the box's reverse proxy serves.
 *
 * Slowcook is stateless re: hosting. Each consumer provides their own
 * SSH-reachable box (Docker engine + reverse proxy with wildcard cert);
 * this config tells slowcook how to reach it.
 *
 * Hand-parsed (no yaml dep) because the schema is small + flat. If we
 * ever need anchors / multi-doc / etc, switch to the workspace's `yaml`
 * package — it's already a transitive dep via cli/dependencies.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface PreviewConfig {
  type: "ssh";
  host: string;
  user: string;
  /** GitHub Actions secret NAME holding the SSH private key. */
  keySecret: string;
  port: number;
  /** Inclusive range to allocate Docker host ports from (e.g. [4000, 4099]). */
  portRange: [number, number];
  /** URL template; `{port}` is substituted. e.g. https://mock-{port}.preview.example.com */
  urlTemplate: string;
  /** Absolute path on the box where slowcook stages PR builds. */
  remoteRoot: string;
  /** Path within the consumer's repo to the mock app. Default: "mock". */
  mockDir: string;
}

export class PreviewConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PreviewConfigError";
  }
}

export const PREVIEW_CONFIG_PATH = ".brewing/preview.yaml";

/**
 * Parse `.brewing/preview.yaml`. Returns the typed config or throws
 * `PreviewConfigError` with a precise message identifying the missing
 * or malformed field.
 *
 * Accepts either:
 *
 *   preview:
 *     type: ssh
 *     host: ...
 *     ...
 *
 * or top-level keys (the `preview:` wrapper is optional but
 * recommended; consumers will likely add a `box:` or other top-level
 * sections later).
 */
export function parsePreviewConfig(yamlText: string): PreviewConfig {
  const lines = yamlText.split(/\r?\n/);
  // Track inside-`preview:` block by indentation; allow flat top-level too.
  const flat: Record<string, string> = {};
  let inPreview = false;
  let baseIndent = -1;
  for (const raw of lines) {
    const line = raw.replace(/#.*$/, ""); // strip comments
    if (line.trim() === "") continue;
    const indentMatch = line.match(/^(\s*)/);
    const indent = indentMatch ? indentMatch[1]!.length : 0;
    const content = line.slice(indent);

    if (indent === 0 && content.startsWith("preview:")) {
      inPreview = true;
      baseIndent = -1;
      continue;
    }
    if (indent === 0 && content.includes(":") && !content.startsWith("preview:")) {
      // top-level key outside preview — could be a sibling block we don't parse
      inPreview = false;
      const m = content.match(/^([a-zA-Z_][\w-]*)\s*:\s*(.*)$/);
      if (m && m[2]?.trim()) {
        flat[m[1]!] = stripQuotes(m[2]!.trim());
      }
      continue;
    }
    if (inPreview) {
      if (baseIndent === -1) baseIndent = indent;
      if (indent < baseIndent) {
        inPreview = false;
        continue;
      }
      const m = content.match(/^([a-zA-Z_][\w-]*)\s*:\s*(.*)$/);
      if (m) {
        flat[m[1]!] = stripQuotes(m[2]!.trim());
      }
    }
  }

  const required: Array<keyof PreviewConfig> = [
    "type",
    "host",
    "user",
    "keySecret",
    "urlTemplate",
    "remoteRoot",
  ];
  // Map snake_case YAML to camelCase keys.
  const aliasMap: Record<string, keyof PreviewConfig> = {
    type: "type",
    host: "host",
    user: "user",
    key_secret: "keySecret",
    keysecret: "keySecret",
    url_template: "urlTemplate",
    urltemplate: "urlTemplate",
    remote_root: "remoteRoot",
    remoteroot: "remoteRoot",
    port: "port",
    port_range: "portRange",
    portrange: "portRange",
    mock_dir: "mockDir",
    mockdir: "mockDir",
  };
  const cfg: Partial<PreviewConfig> = {};
  for (const [k, v] of Object.entries(flat)) {
    const camel = aliasMap[k.toLowerCase()];
    if (!camel) continue;
    if (camel === "port") {
      cfg.port = parseInt(v, 10);
    } else if (camel === "portRange") {
      const m = v.match(/^\[?\s*(\d+)\s*,\s*(\d+)\s*\]?$/);
      if (!m) {
        throw new PreviewConfigError(
          `preview.port_range: expected "[lo, hi]"; got ${JSON.stringify(v)}`
        );
      }
      const lo = parseInt(m[1]!, 10);
      const hi = parseInt(m[2]!, 10);
      if (lo > hi || lo <= 0 || hi > 65535) {
        throw new PreviewConfigError(
          `preview.port_range: ${lo}..${hi} is not a valid port range`
        );
      }
      cfg.portRange = [lo, hi];
    } else {
      // string fields
      (cfg as Record<string, string>)[camel] = v;
    }
  }

  for (const k of required) {
    if (cfg[k] === undefined || cfg[k] === "") {
      throw new PreviewConfigError(
        `preview.${snakeOf(k)} is required in ${PREVIEW_CONFIG_PATH}.`
      );
    }
  }
  if (cfg.type !== "ssh") {
    throw new PreviewConfigError(
      `preview.type must be "ssh" (got ${JSON.stringify(cfg.type)}). Other deploy types may ship later.`
    );
  }
  if (!cfg.urlTemplate!.includes("{port}")) {
    throw new PreviewConfigError(
      `preview.url_template must contain the literal "{port}" placeholder; got ${JSON.stringify(cfg.urlTemplate)}.`
    );
  }
  return {
    type: "ssh",
    host: cfg.host!,
    user: cfg.user!,
    keySecret: cfg.keySecret!,
    port: cfg.port ?? 22,
    portRange: cfg.portRange ?? [4000, 4099],
    urlTemplate: cfg.urlTemplate!,
    remoteRoot: cfg.remoteRoot!,
    mockDir: cfg.mockDir ?? "mock",
  };
}

export function readPreviewConfig(repoRoot: string): PreviewConfig {
  const p = join(repoRoot, PREVIEW_CONFIG_PATH);
  if (!existsSync(p)) {
    throw new PreviewConfigError(
      `${PREVIEW_CONFIG_PATH} not found at ${p}. ` +
        `See docs/operating-guide.md for the schema + box setup steps.`
    );
  }
  const text = readFileSync(p, "utf8");
  return parsePreviewConfig(text);
}

function stripQuotes(s: string): string {
  if (
    (s.startsWith('"') && s.endsWith('"')) ||
    (s.startsWith("'") && s.endsWith("'"))
  ) {
    return s.slice(1, -1);
  }
  return s;
}

function snakeOf(camel: string): string {
  return camel.replace(/([A-Z])/g, "_$1").toLowerCase();
}

/**
 * Build the preview URL for a given allocated port.
 */
export function urlForPort(cfg: PreviewConfig, port: number): string {
  return cfg.urlTemplate.replace("{port}", String(port));
}

/**
 * Container name for a given PR. Single source of truth so deploy +
 * teardown agree on the name.
 */
export function containerNameForPr(pr: number): string {
  return `slowcook-mock-pr-${pr}`;
}

/**
 * Image tag for a given PR. We rebuild per-PR (each PR has its own
 * scenario set), so tags don't collide.
 */
export function imageTagForPr(pr: number): string {
  return `slowcook-mock-pr-${pr}:latest`;
}

/**
 * Remote staging directory for a given PR. Build artifacts + the tar
 * extract live here.
 */
export function remoteDirForPr(cfg: PreviewConfig, pr: number): string {
  return `${cfg.remoteRoot.replace(/\/+$/, "")}/pr-${pr}`;
}
