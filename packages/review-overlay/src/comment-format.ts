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
  element: {
    selector: string;
    fallback_selector: string | null;
    strategy: ExtractedSelector["strategy"];
    tag: string;
    text_hint: string | null;
    /** Bounding box in CSS pixels at submit time. */
    bbox: { x: number; y: number; w: number; h: number };
  };
  viewport: ViewportInfo;
  user_agent: string;
}

export const PAYLOAD_MARKER = "slowcook:review-overlay";

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

  lines.push(`### Review comment — \`${payload.element.selector}\``);
  lines.push("");

  lines.push(`**Element:** \`${payload.element.tag}\` ${payload.element.text_hint ? `· "${payload.element.text_hint}"` : ""}`);
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
  return (
    typeof o["slowcook_overlay_version"] === "string" &&
    typeof o["url"] === "string" &&
    typeof o["timestamp"] === "string" &&
    typeof o["prose"] === "string" &&
    typeof o["element"] === "object" && o["element"] !== null &&
    typeof o["viewport"] === "object" && o["viewport"] !== null
  );
}

export function buildPayload(args: {
  overlayVersion: string;
  storyId: string | null;
  url: string;
  prose: string;
  selector: ExtractedSelector;
  bbox: { x: number; y: number; w: number; h: number };
  viewport: ViewportInfo;
  userAgent: string;
}): ReviewCommentPayload {
  return {
    slowcook_overlay_version: args.overlayVersion,
    story_id: args.storyId,
    url: args.url,
    timestamp: new Date().toISOString(),
    prose: args.prose,
    element: {
      selector: args.selector.selector,
      fallback_selector: args.selector.fallbackSelector,
      strategy: args.selector.strategy,
      tag: args.selector.tag,
      text_hint: args.selector.textHint,
      bbox: args.bbox,
    },
    viewport: args.viewport,
    user_agent: args.userAgent,
  };
}
