/**
 * 0.6.0 — LCR free-nav route hint (pure).
 *
 * In LCR review mode the reviewer roams the mock's own router and leaves
 * comments on arbitrary routes (`/r/<slug>`, `/discover`, ...). Each
 * review-overlay comment carries the route it was left on. Plate surfaces
 * that route to the amendment agent so it edits the component rendering
 * THAT page rather than guessing from the element selector alone.
 *
 * `pathname` is set by the overlay in LCR mode; older / scenario-mode
 * payloads omit it, so we fall back to parsing the captured `url`.
 */
import type { ReviewCommentPayload } from "@slowcook-ai/review-overlay";

/** The route (path + query) a comment was left on, or undefined if unknowable. */
export function routeOf(payload: Pick<ReviewCommentPayload, "pathname" | "route_query" | "url">): string | undefined {
  const path =
    payload.pathname ??
    (() => {
      try {
        return new URL(payload.url).pathname;
      } catch {
        return undefined;
      }
    })();
  if (!path) return undefined;
  return `${path}${payload.route_query ?? ""}`;
}

/** A `" on route \`/x\`"` fragment for the agent timeline, or "" when unknown. */
export function routeHint(payload: Pick<ReviewCommentPayload, "pathname" | "route_query" | "url">): string {
  const route = routeOf(payload);
  return route ? ` on route \`${route}\`` : "";
}
