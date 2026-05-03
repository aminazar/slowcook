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

import type { ExtractedSelector } from "./selector.js";

export interface ViewportInfo {
  width: number;
  height: number;
  /** Color scheme: light / dark / no-preference. */
  colorScheme: "light" | "dark" | "no-preference";
  /** Device pixel ratio. */
  dpr: number;
}

export interface ReviewCommentPayload {
  slowcook_overlay_version: string;
  story_id: string | null;
  url: string;
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
    /** Bounding box in CSS pixels at submit time. */
    bbox: { x: number; y: number; w: number; h: number };
  } | null;
  viewport: ViewportInfo;
  user_agent: string;
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
  | "applied"        // plate amended the mock per the comment
  | "declined"       // plate read the comment but chose not to amend (cosmetic-but-already-fine)
  | "spec-altering"  // plate escalated; PM must confirm a spec change
  | "noop";          // plate considered, no diff produced (re-emit yielded byte-identical files)

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
  /** Optional inline screenshot data URL (image/png). */
  screenshotDataUrl?: string;
}

/**
 * Render the full comment body (markdown + hidden JSON). The hidden
 * JSON is wrapped in an HTML comment with a stable marker so plate's
 * parser can locate + decode it idempotently.
 */
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
  lines.push(
    `**Viewport:** ${payload.viewport.width}×${payload.viewport.height} ${payload.viewport.colorScheme} (dpr ${payload.viewport.dpr})`
  );
  lines.push(`**URL:** ${payload.url}`);
  lines.push("");

  lines.push(`> ${payload.prose.split("\n").join("\n> ")}`);
  lines.push("");

  if (screenshotDataUrl) {
    lines.push(`![screenshot](${screenshotDataUrl})`);
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

export function buildPayload(args: {
  overlayVersion: string;
  storyId: string | null;
  url: string;
  prose: string;
  /**
   * 0.5.0 — selector + bbox are now optional. Pass both for
   * element-anchored comments; pass neither for general comments.
   */
  selector?: ExtractedSelector;
  bbox?: { x: number; y: number; w: number; h: number };
  viewport: ViewportInfo;
  userAgent: string;
}): ReviewCommentPayload {
  const element =
    args.selector && args.bbox
      ? {
          selector: args.selector.selector,
          fallback_selector: args.selector.fallbackSelector,
          strategy: args.selector.strategy,
          tag: args.selector.tag,
          text_hint: args.selector.textHint,
          bbox: args.bbox,
        }
      : null;
  return {
    slowcook_overlay_version: args.overlayVersion,
    story_id: args.storyId,
    url: args.url,
    timestamp: new Date().toISOString(),
    prose: args.prose,
    element,
    viewport: args.viewport,
    user_agent: args.userAgent,
  };
}
