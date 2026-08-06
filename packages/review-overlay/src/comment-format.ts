/**
 * Comment markdown + JSON-payload formatter — 0.16.0-α.6.
 *
 * The overlay submits each comment as a single GitHub PR comment whose
 * body is:
 *
 *   - human-readable markdown (selector, viewport, prose)
 *   - HTML-comment-hidden JSON payload (the structured data plate parses)
 *
 * Plate's parser greps for the payload marker; humans see the rendered
 * markdown. Same idea as the cost-marker rollups slowcook already uses.
 *
 * Pure function; no DOM access.
 */

import type { ExtractedSelector, A11yPath } from "./selector.js";

export interface ViewportInfo {
  width: number;
  height: number;
  /** Color scheme: light / dark / no-preference. */
  colorScheme: "light" | "dark" | "no-preference";
  /** Device pixel ratio. */
  dpr: number;
}

/**
 * The EPSS selection active when the comment was filed (epic ▸ context ▸
 * scenario ▸ state) — so plate knows the exact precondition/state the reviewer
 * was looking at, rather than guessing from the route (multiple states share a
 * route, and the state lives in localStorage, not the URL).
 */
export interface SurfaceContext {
  epicId: string;
  contextId: string;
  scenarioId: string;
  stateId: string;
  /** Human-readable breadcrumb, e.g. "Patient › Consider a therapist › Chosen one". */
  crumb: string;
}

/** Coarse device class from viewport width — for plate + humans. */
export function viewportMode(width: number): "mobile" | "desktop" {
  return width < 768 ? "mobile" : "desktop";
}

export interface ReviewCommentPayload {
  slowcook_overlay_version: string;
  story_id: string | null;
  url: string;
  /**
   * 0.6.0 — the route the comment was left on, split out from `url` for
   * convenience. In LCR review mode the reviewer roams the mock's own
   * router (e.g. `/r/webb-deep-field`, `/discover`), so plate keys
   * amendments by route, not by a single per-PR story_id. Optional for
   * back-compat: older payloads (and scenario-mode comments) omit it,
   * and consumers can recover it from `url` when absent.
   */
  pathname?: string;
  /** 0.6.0 — the query string at comment time (e.g. `?clean=1`), if any. */
  route_query?: string;
  /**
   * 0.6.0 — the story/requirement the commented route belongs to, when the LCR
   * declares it at runtime (data-slowcook-story). Lets an LCR review comment
   * become a contextualised issue tagged with the exact requirement; absent
   * when the LCR doesn't self-report (vibe can still derive it from the route).
   */
  route_story?: string;
  timestamp: string;
  prose: string;
  /**
   * 0.5.0 — element is now OPTIONAL. Comments can be anchored to a
   * specific element (the original click-an-element flow) OR general
   * (no anchor — about overall behavior, e.g. "show error on bad
   * input"). General comments don't render as pins; they appear only
   * in the comments-list panel.
   */
  element: {
    selector: string;
    fallback_selector: string | null;
    strategy: ExtractedSelector["strategy"];
    tag: string;
    text_hint: string | null;
    /** Semantic anchor (role + name + container path) — preferred over the CSS
     *  selector on resolve; absent for legacy comments captured before #1. */
    a11y?: A11yPath | null;
    /** Bounding box in CSS pixels at submit time. */
    bbox: { x: number; y: number; w: number; h: number };
  } | null;
  viewport: ViewportInfo;
  user_agent: string;
  /**
   * Full review CONTEXT so plate never guesses the conditions. `viewport`
   * already carries colorScheme (dark/light) + size (mobile/desktop); these add
   * the EPSS state and the UI language. Present on BOTH element-anchored and
   * general (page-level) comments.
   */
  surface?: SurfaceContext | null;
  /** App language at comment time, e.g. "fa" | "en" (document.documentElement.lang). */
  lang?: string;
  /**
   * 0.19.0 — the EVIDENCE TAIL: the browser's last ~60s (API calls with
   * status/timing/X-Request-Id/Server-Timing, failure bodies truncated,
   * console errors, route changes, coarse actions). Lets an investigating
   * agent join a pixel complaint to the dev backend's own logs by request
   * id without a repro. Additive — older parsers ignore it.
   */
  evidence?: EvidenceTail;
}

export interface EvidenceTail {
  window_ms: number;
  entries: EvidenceEntry[];
  /** 0.20.0 — which code was even running: frontend build id (env/prop) and
   *  the backend's version-ish header, first one seen. Dev mode's ghost bugs
   *  are stale-code bugs; this kills the class. */
  identity?: { frontend?: string; backend?: string };
  /** 0.20.0 — socket traffic COUNTED by frame type (ws:order_updated: 12);
   *  frames are never stored. */
  sockets?: Record<string, number>;
}

export interface EvidenceEntry {
  t: number;
  kind: "fetch" | "error" | "route" | "mark" | "action";
  msg: string;
  status?: number;
  requestId?: string;
  ms?: number;
  serverTiming?: string;
  body?: string;
  requestBody?: string;
  debug?: Record<string, string>;
}

export const PAYLOAD_MARKER = "slowcook:review-overlay";

/**
 * 0.3.0 — Plate-reply breadcrumb. Plate emits this JSON block at the
 * end of its amendment summary so the overlay can correlate each
 * reply to the original review-overlay comment by ID without any
 * timestamp heuristics. One reply entry per overlay comment plate
 * processed in the run.
 */
export const PLATE_REPLY_MARKER = "slowcook:plate-reply";

export type PlateReplyStatus =
  | "applied"            // plate/vibe amended the mock per the comment
  | "declined"           // read the comment but chose not to amend (cosmetic-but-already-fine)
  | "spec-altering"      // escalated; PM must confirm a spec change
  | "needs-clarification" // 0.6.0 — couldn't act on it; asked the reviewer to clarify
  | "noop";              // considered, no diff produced (re-emit yielded byte-identical files)

/**
 * 0.6.0 — which reply statuses are "resolved" (the comment can be hidden behind
 * the overlay's "show applied" toggle). `needs-clarification` is intentionally
 * NOT resolved: it stays visible so the reviewer sees the question and answers.
 */
export function isResolvedStatus(s: PlateReplyStatus): boolean {
  return s === "applied" || s === "declined" || s === "noop";
}

export interface PlateReplyEntry {
  /** GitHub comment id of the overlay comment this reply addresses. */
  to_comment_id: number;
  status: PlateReplyStatus;
  /** One-line summary of plate's action (what changed, or why declined). */
  summary: string;
  /** Files plate touched as part of resolving this comment (mock/ paths). */
  files_touched?: string[];
}

export interface PlateReplyPayload {
  version: string;
  /** Commit SHA plate force-pushed (when status applies); null on no-op / escalate. */
  amendment_commit?: string | null;
  replies: PlateReplyEntry[];
}

/**
 * Build the HTML-comment block plate appends to its summary so the
 * overlay can correlate replies to overlay comments.
 */
export function formatPlateReplyBlock(p: PlateReplyPayload): string {
  return [
    "<!--",
    PLATE_REPLY_MARKER,
    JSON.stringify(p),
    "-->",
  ].join("\n");
}

/**
 * Reverse — extract the plate-reply payload from a comment body.
 * Returns null when the comment isn't a plate reply or the payload is
 * malformed.
 */
export function parsePlateReply(body: string): PlateReplyPayload | null {
  const idx = body.indexOf(PLATE_REPLY_MARKER);
  if (idx < 0) return null;
  const tail = body.slice(idx + PLATE_REPLY_MARKER.length);
  const closeIdx = tail.indexOf("-->");
  const region = closeIdx < 0 ? tail : tail.slice(0, closeIdx);
  const m = region.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const parsed = JSON.parse(m[0]) as unknown;
    if (!isPlateReplyPayload(parsed)) return null;
    return parsed;
  } catch {
    return null;
  }
}

function isPlateReplyPayload(v: unknown): v is PlateReplyPayload {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  if (typeof o["version"] !== "string") return false;
  if (!Array.isArray(o["replies"])) return false;
  for (const r of o["replies"]) {
    if (!r || typeof r !== "object") return false;
    const e = r as Record<string, unknown>;
    if (typeof e["to_comment_id"] !== "number") return false;
    if (typeof e["status"] !== "string") return false;
    if (typeof e["summary"] !== "string") return false;
  }
  return true;
}

export interface FormatArgs {
  payload: ReviewCommentPayload;
  /** Optional inline screenshot data URL (image/png or jpeg). Small crops only —
   *  a GitHub comment body caps at ~65k chars. */
  screenshotDataUrl?: string;
  /** 0.19.0 — the uploaded screenshot's blob URL (Contents API asset). Renders
   *  as a link; on private repos the viewer's own session authenticates it. */
  screenshotUrl?: string;
}

/**
 * Render the full comment body (markdown + hidden JSON). The hidden
 * JSON is wrapped in an HTML comment with a stable marker so plate's
 * parser can locate + decode it idempotently.
 */
const fence = (s: string): string => s.replace(/`/g, "\u0060").replace(/\n/g, " ").slice(0, 500);

/** The ONE evidence renderer (0.21.0) — used by the PR-comment overlay and
 *  the issue-filing shell alike, so both transports read identically. */
export function renderEvidenceMarkdown(ev: EvidenceTail): string[] {
  const lines: string[] = [];
  lines.push(`<details><summary>evidence — last ${Math.round(ev.window_ms / 1000)}s (${ev.entries.length} entries)</summary>`);
  lines.push("");
  if (ev.identity?.frontend || ev.identity?.backend) {
    lines.push(`**Running:** ${[ev.identity.frontend ? `frontend \`${ev.identity.frontend}\`` : "", ev.identity.backend ? `backend \`${ev.identity.backend}\`` : ""].filter(Boolean).join(" · ")}`);
    lines.push("");
  }
  for (const e of ev.entries) {
    const at = new Date(e.t).toISOString().slice(11, 19);
    const bits = [
      `\`${at}\` ${e.kind === "fetch" ? "🌐" : e.kind === "error" ? "🟥" : e.kind === "action" ? "👆" : "➡️"} ${e.msg}`,
      e.status != null ? `**${e.status}**` : "",
      e.ms != null ? `${e.ms}ms` : "",
      e.requestId ? `req \`${e.requestId}\`` : "",
      e.serverTiming ? `⏱ \`${e.serverTiming}\`` : "",
    ].filter(Boolean);
    lines.push(`- ${bits.join(" · ")}`);
    if (e.requestBody) lines.push(`  - req: \`${fence(e.requestBody)}\``);
    if (e.body) lines.push(`  - res: \`${fence(e.body)}\``);
    if (e.debug) for (const [k, v] of Object.entries(e.debug)) lines.push(`  - \`${k}: ${fence(v)}\``);
  }
  if (ev.sockets && Object.keys(ev.sockets).length) {
    lines.push("");
    lines.push(`**Sockets:** ${Object.entries(ev.sockets).map(([k, n]) => `\`${k}\` ×${n}`).join(" · ")}`);
  }
  lines.push("");
  lines.push("</details>");
  return lines;
}

export function formatReviewComment(args: FormatArgs): string {
  const { payload, screenshotDataUrl } = args;
  const lines: string[] = [];

  if (payload.element) {
    lines.push(`### Review comment — \`${payload.element.selector}\``);
    lines.push("");
    lines.push(`**Element:** \`${payload.element.tag}\` ${payload.element.text_hint ? `· "${payload.element.text_hint}"` : ""}`);
  } else {
    // 0.5.0 — general comment, no element anchor.
    lines.push(`### Review note (general — no element anchor)`);
    lines.push("");
  }
  // Full context so plate (and humans) never guess the conditions. Rendered for
  // BOTH element-anchored and general (page-level) comments.
  lines.push(
    `**Viewport:** ${payload.viewport.width}×${payload.viewport.height} (${viewportMode(payload.viewport.width)}) · ${payload.viewport.colorScheme} mode${payload.lang ? ` · lang \`${payload.lang}\`` : ""} (dpr ${payload.viewport.dpr})`
  );
  if (payload.surface) {
    lines.push(
      `**State (EPSS):** ${payload.surface.crumb}  \`${payload.surface.epicId} ▸ ${payload.surface.contextId} ▸ ${payload.surface.scenarioId} ▸ ${payload.surface.stateId}\``
    );
  }
  if (payload.pathname) {
    lines.push(`**Route:** \`${payload.pathname}${payload.route_query ?? ""}\``);
  }
  lines.push(`**URL:** ${payload.url}`);
  lines.push("");

  lines.push(`> ${payload.prose.split("\n").join("\n> ")}`);
  lines.push("");

  if (screenshotDataUrl) {
    lines.push(`![screenshot](${screenshotDataUrl})`);
    lines.push("");
  }
  if (args.screenshotUrl) {
    lines.push(`📸 [screenshot — the commented element, ringed](${args.screenshotUrl})`);
    lines.push("");
  }

  // THE EVIDENCE TAIL (0.19.0) — collapsed, human-scannable, and duplicated
  // inside the hidden JSON so plate reads structure, not markdown.
  if (payload.evidence && payload.evidence.entries.length) {
    lines.push(...renderEvidenceMarkdown(payload.evidence));
    lines.push("");
  }

  // Hidden JSON for plate. Wrap in HTML comment + payload marker so the
  // parser can grep + decode without parsing markdown structure.
  lines.push("<!--");
  lines.push(PAYLOAD_MARKER);
  lines.push(JSON.stringify(payload));
  lines.push("-->");

  return lines.join("\n");
}

/**
 * Reverse — given a rendered comment body, extract the JSON payload if
 * present. Returns null when the body has no payload (i.e., it isn't
 * a review-overlay comment).
 *
 * Plate uses this to ingest each review-overlay comment on a mockup PR.
 */
export function parseReviewComment(body: string): ReviewCommentPayload | null {
  const idx = body.indexOf(PAYLOAD_MARKER);
  if (idx < 0) return null;
  // The JSON is on the line after the marker, before `-->`.
  const tail = body.slice(idx + PAYLOAD_MARKER.length);
  const closeIdx = tail.indexOf("-->");
  const region = closeIdx < 0 ? tail : tail.slice(0, closeIdx);
  const m = region.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const parsed = JSON.parse(m[0]) as unknown;
    if (!isReviewCommentPayload(parsed)) return null;
    return parsed;
  } catch {
    return null;
  }
}

function isReviewCommentPayload(v: unknown): v is ReviewCommentPayload {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  // 0.5.0 — element is allowed to be null (general comment).
  const elementOk =
    o["element"] === null ||
    (typeof o["element"] === "object" && o["element"] !== null);
  return (
    typeof o["slowcook_overlay_version"] === "string" &&
    typeof o["url"] === "string" &&
    typeof o["timestamp"] === "string" &&
    typeof o["prose"] === "string" &&
    elementOk &&
    typeof o["viewport"] === "object" && o["viewport"] !== null
  );
}

/**
 * 0.6.0 — LCR contextualised issue. In LCR review a comment isn't about one PR;
 * it's about a route → a story/requirement of the living spec. So an LCR comment
 * becomes a standalone issue that says (a) it's about the LCR, (b) which story,
 * (c) carries the `vibe` label so vibe picks it up + applies the fix to the mock.
 */
export const LCR_REVIEW_LABEL = "lcr-review";
export const VIBE_LABEL = "vibe";
// Comments from reviewers WITHOUT repo write access carry this label instead of
// `vibe`. The apply pipeline only acts on `vibe`, so these are never auto-applied
// — they're gathered for the team/PM to triage (and promote to `vibe` if wanted).
export const COMMUNITY_LABEL = "community-review";

/**
 * A concise, readable issue title from the reviewer's own words (#946).
 *
 * The old titles led with the anchored element's inner text — for a Farsi or
 * financial widget a concatenated run-on ("Available to withdraw⁦150 USDT⁩…")
 * — then a mid-word slice of the comment. The element text is noise in a
 * title: it is context, and it already lives in the body. The reviewer's
 * COMMENT is the intent, so the title is the comment, cleaned:
 *
 *   · whitespace collapsed, the first sentence preferred when it stands alone
 *   · truncated on a WORD boundary near 70 chars, "…" only when actually cut
 *   · a leading Latin letter sentence-cased; RTL/other scripts left untouched
 *
 * No bracket prefix — the labels already carry the scope. Purely cosmetic:
 * hydration reads the body, never the title.
 */
export function conciseIssueTitle(intent: string): string {
  const flat = (intent ?? "").replace(/\s+/g, " ").trim();
  if (!flat) return "Review note";
  const MAX = 70;
  // a self-contained first sentence makes the tightest possible title
  const firstSentence = flat.split(/(?<=[.!?؟])\s+/)[0] || flat;
  let base = firstSentence.length <= MAX ? firstSentence : flat;
  if (base.length > MAX) {
    const cut = base.slice(0, MAX);
    const sp = cut.lastIndexOf(" ");
    base = (sp > MAX * 0.5 ? cut.slice(0, sp) : cut).replace(/[\s.,;:!?،؛'"“”«»()[\]—–-]+$/u, "") + "…";
  } else {
    base = base.replace(/\.+$/, ""); // a short title needs no full stop
  }
  return base.replace(/^\p{Ll}/u, (m) => m.toUpperCase());
}

export interface LcrIssue {
  title: string;
  body: string;
  labels: string[];
}

/** Build the title/body/labels for an LCR review issue (pure).
 *  `canApply` (default true) reflects the reviewer's repo write access: when
 *  false the issue is labelled `community-review` (held for the team) rather
 *  than `vibe` (auto-applied). */
export function formatLcrIssue(args: {
  payload: ReviewCommentPayload;
  screenshotDataUrl?: string;
  /** 0.19.0 — uploaded screenshot asset (Contents API blob URL). */
  screenshotUrl?: string;
  canApply?: boolean;
}): LcrIssue {
  const canApply = args.canApply !== false;
  const { payload } = args;
  const route = payload.pathname ? `${payload.pathname}${payload.route_query ?? ""}` : undefined;
  const story = payload.route_story;
  // intent-only title (#946): the story/route locator stays in the body and
  // (for a story) in the labels, so nothing is lost by leaving it off the title.
  const title = conciseIssueTitle(payload.prose);

  const lines: string[] = [];
  lines.push(`**Living Coded Requirement review note**`);
  lines.push("");
  if (story) lines.push(`**Story / requirement:** \`story-${story.replace(/^story-/, "")}\``);
  if (route) lines.push(`**Route:** \`${route}\``);
  if (payload.element) {
    lines.push(`**Element:** \`${payload.element.selector}\` (${payload.element.tag}${payload.element.text_hint ? ` · "${payload.element.text_hint}"` : ""})`);
  }
  lines.push(`**Viewport:** ${payload.viewport.width}×${payload.viewport.height} ${payload.viewport.colorScheme}`);
  lines.push("");
  lines.push(`> ${payload.prose.split("\n").join("\n> ")}`);
  lines.push("");
  if (args.screenshotDataUrl) { lines.push(`![screenshot](${args.screenshotDataUrl})`); lines.push(""); }
  if (args.screenshotUrl) { lines.push(`📸 [screenshot — the commented element, ringed](${args.screenshotUrl})`); lines.push(""); }
  lines.push(canApply
    ? `_Filed from the LCR review overlay — labelled \`${VIBE_LABEL}\` for vibe to apply to the mock._`
    : `_Filed from the LCR review overlay by a reviewer without repo write access — labelled \`${COMMUNITY_LABEL}\` and gathered for the team to review (not auto-applied)._`);
  lines.push("");
  lines.push("<!--");
  lines.push(PAYLOAD_MARKER);
  lines.push(JSON.stringify(payload));
  lines.push("-->");

  const labels = [LCR_REVIEW_LABEL, canApply ? VIBE_LABEL : COMMUNITY_LABEL];
  if (story) labels.push(`story-${story.replace(/^story-/, "")}`);
  return { title, body: lines.join("\n"), labels };
}

export function buildPayload(args: {
  overlayVersion: string;
  storyId: string | null;
  url: string;
  /** 0.6.0 — current route path (window.location.pathname). */
  pathname?: string;
  /** 0.6.0 — current query string (window.location.search). */
  routeQuery?: string;
  /** 0.6.0 — story the route belongs to (LCR runtime self-report). */
  routeStory?: string;
  prose: string;
  /**
   * 0.5.0 — selector + bbox are now optional. Pass both for
   * element-anchored comments; pass neither for general comments.
   */
  selector?: ExtractedSelector;
  bbox?: { x: number; y: number; w: number; h: number };
  viewport: ViewportInfo;
  userAgent: string;
  /** EPSS selection active at comment time (epic ▸ context ▸ scenario ▸ state). */
  surface?: SurfaceContext | null;
  /** UI language at comment time (e.g. "fa" | "en"). */
  lang?: string;
}): ReviewCommentPayload {
  const element =
    args.selector && args.bbox
      ? {
          selector: args.selector.selector,
          fallback_selector: args.selector.fallbackSelector,
          strategy: args.selector.strategy,
          tag: args.selector.tag,
          text_hint: args.selector.textHint,
          a11y: args.selector.a11y ?? null,
          bbox: args.bbox,
        }
      : null;
  return {
    slowcook_overlay_version: args.overlayVersion,
    story_id: args.storyId,
    url: args.url,
    ...(args.pathname ? { pathname: args.pathname } : {}),
    ...(args.routeQuery ? { route_query: args.routeQuery } : {}),
    ...(args.routeStory ? { route_story: args.routeStory } : {}),
    timestamp: new Date().toISOString(),
    prose: args.prose,
    element,
    viewport: args.viewport,
    user_agent: args.userAgent,
    ...(args.surface ? { surface: args.surface } : {}),
    ...(args.lang ? { lang: args.lang } : {}),
  };
}
