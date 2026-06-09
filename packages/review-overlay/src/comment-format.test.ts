import { describe, it, expect } from "vitest";
import {
  formatReviewComment,
  parseReviewComment,
  buildPayload,
  formatLcrIssue,
  LCR_REVIEW_LABEL,
  VIBE_LABEL,
  PAYLOAD_MARKER,
} from "./comment-format.js";
import type { ExtractedSelector } from "./selector.js";

const sampleSelector: ExtractedSelector = {
  selector: "#unread-badge",
  fallbackSelector: "span.badge",
  strategy: "id",
  tag: "span",
  textHint: "3",
};

const sampleViewport = {
  width: 390,
  height: 844,
  colorScheme: "dark" as const,
  dpr: 3,
};

describe("buildPayload", () => {
  it("populates every required field + carries the timestamp", () => {
    const before = Date.now();
    const p = buildPayload({
      overlayVersion: "0.1.0",
      storyId: "017",
      url: "http://localhost:3100/u/amin?scenario=017",
      prose: "Should be coral.",
      selector: sampleSelector,
      bbox: { x: 142, y: 73, w: 22, h: 22 },
      viewport: sampleViewport,
      userAgent: "Mozilla/5.0 …",
    });
    const after = Date.now();
    expect(p.slowcook_overlay_version).toBe("0.1.0");
    expect(p.story_id).toBe("017");
    expect(p.url).toBe("http://localhost:3100/u/amin?scenario=017");
    expect(p.prose).toBe("Should be coral.");
    expect(p.element).toMatchObject({
      selector: "#unread-badge",
      fallback_selector: "span.badge",
      strategy: "id",
      tag: "span",
      text_hint: "3",
      bbox: { x: 142, y: 73, w: 22, h: 22 },
    });
    expect(p.viewport).toEqual(sampleViewport);
    const ts = Date.parse(p.timestamp);
    expect(ts).toBeGreaterThanOrEqual(before);
    expect(ts).toBeLessThanOrEqual(after);
  });

  it("accepts null storyId", () => {
    const p = buildPayload({
      overlayVersion: "0.1.0",
      storyId: null,
      url: "http://x",
      prose: "x",
      selector: sampleSelector,
      bbox: { x: 0, y: 0, w: 0, h: 0 },
      viewport: sampleViewport,
      userAgent: "x",
    });
    expect(p.story_id).toBeNull();
  });

  // 0.6.0 — LCR free-nav: the comment carries the route it was left on.
  it("captures pathname + route_query when supplied (LCR mode)", () => {
    const p = buildPayload({
      overlayVersion: "0.6.0",
      storyId: "rewo-lcr",
      url: "http://localhost:3100/r/webb-deep-field?clean=1",
      pathname: "/r/webb-deep-field",
      routeQuery: "?clean=1",
      prose: "Bucket order looks off here.",
      viewport: sampleViewport,
      userAgent: "x",
    });
    expect(p.pathname).toBe("/r/webb-deep-field");
    expect(p.route_query).toBe("?clean=1");
    // round-trips through the markdown body + survives the parser
    const body = formatReviewComment({ payload: p });
    expect(body).toContain("**Route:** `/r/webb-deep-field?clean=1`");
    const back = parseReviewComment(body);
    expect(back?.pathname).toBe("/r/webb-deep-field");
    expect(back?.route_query).toBe("?clean=1");
  });

  it("omits route fields when not supplied (scenarios mode / back-compat)", () => {
    const p = buildPayload({
      overlayVersion: "0.6.0",
      storyId: "017",
      url: "http://localhost:3100/",
      prose: "x",
      selector: sampleSelector,
      bbox: { x: 0, y: 0, w: 0, h: 0 },
      viewport: sampleViewport,
      userAgent: "x",
    });
    expect(p.pathname).toBeUndefined();
    expect(p.route_query).toBeUndefined();
    expect(formatReviewComment({ payload: p })).not.toContain("**Route:**");
  });
});

describe("formatReviewComment + parseReviewComment round trip", () => {
  it("renders a well-formed body that re-parses to the same payload", () => {
    const payload = buildPayload({
      overlayVersion: "0.1.0",
      storyId: "017",
      url: "http://localhost:3100/u/amin?scenario=017",
      prose: "Pin button looks dead.\n\nThe disabled state is invisible.",
      selector: sampleSelector,
      bbox: { x: 100, y: 200, w: 80, h: 32 },
      viewport: sampleViewport,
      userAgent: "Mozilla/5.0",
    });
    const body = formatReviewComment({ payload });
    expect(body).toContain("### Review comment — `#unread-badge`");
    expect(body).toContain("**Element:** `span` · \"3\"");
    expect(body).toContain("**Viewport:** 390×844 dark (dpr 3)");
    expect(body).toContain("> Pin button looks dead.");
    expect(body).toContain("> ");
    expect(body).toContain("> The disabled state is invisible.");
    expect(body).toContain(PAYLOAD_MARKER);

    const parsed = parseReviewComment(body);
    expect(parsed).not.toBeNull();
    expect(parsed!.element.selector).toBe("#unread-badge");
    expect(parsed!.prose).toBe(payload.prose);
    expect(parsed!.viewport).toEqual(payload.viewport);
  });

  it("includes a screenshot data URL when provided", () => {
    const payload = buildPayload({
      overlayVersion: "0.1.0",
      storyId: null,
      url: "http://x",
      prose: "x",
      selector: sampleSelector,
      bbox: { x: 0, y: 0, w: 0, h: 0 },
      viewport: sampleViewport,
      userAgent: "x",
    });
    const body = formatReviewComment({
      payload,
      screenshotDataUrl: "data:image/png;base64,iVBOR",
    });
    expect(body).toContain("![screenshot](data:image/png;base64,iVBOR)");
  });
});

describe("parseReviewComment", () => {
  it("returns null for a body without the marker", () => {
    expect(parseReviewComment("Just a regular PR comment.")).toBeNull();
  });

  it("returns null for a body that has the marker but no JSON", () => {
    expect(
      parseReviewComment(`hello\n<!--\n${PAYLOAD_MARKER}\n-->\n`)
    ).toBeNull();
  });

  it("returns null for malformed JSON", () => {
    expect(
      parseReviewComment(`<!--\n${PAYLOAD_MARKER}\n{not real json\n-->`)
    ).toBeNull();
  });

  it("returns null when JSON is missing required fields", () => {
    expect(
      parseReviewComment(`<!--\n${PAYLOAD_MARKER}\n{"foo":"bar"}\n-->`)
    ).toBeNull();
  });

  it("ignores marker mentioned in prose alone", () => {
    // Marker NOT inside an HTML comment + no JSON object → still null.
    expect(parseReviewComment(`free prose ${PAYLOAD_MARKER} prose`)).toBeNull();
  });

  it("extracts JSON nested inside multi-line HTML comment", () => {
    const body = `prose
<!--
${PAYLOAD_MARKER}
{"slowcook_overlay_version":"0.1.0","story_id":null,"url":"http://x","timestamp":"2026-04-26T00:00:00.000Z","prose":"x","element":{"selector":"#a","fallback_selector":null,"strategy":"id","tag":"div","text_hint":null,"bbox":{"x":0,"y":0,"w":0,"h":0}},"viewport":{"width":1,"height":1,"colorScheme":"light","dpr":1},"user_agent":"x"}
-->
trailing prose
`;
    const p = parseReviewComment(body);
    expect(p).not.toBeNull();
    expect(p!.element.selector).toBe("#a");
  });
});

describe("formatLcrIssue", () => {
  const base = {
    overlayVersion: "0.6.0", storyId: "rewo-lcr",
    url: "http://localhost:3100/r/webb-deep-field",
    pathname: "/r/webb-deep-field", routeStory: "104",
    viewport: sampleViewport, userAgent: "x",
  };
  it("titles + labels by story, embeds route + payload, carries vibe label", () => {
    const p = buildPayload({ ...base, prose: "The fascinate bucket should lead." });
    const issue = formatLcrIssue({ payload: p });
    expect(issue.title).toContain("[LCR]");
    expect(issue.title).toContain("story-104");
    expect(issue.labels).toEqual([LCR_REVIEW_LABEL, VIBE_LABEL, "story-104"]);
    expect(issue.body).toContain("**Story / requirement:** `story-104`");
    expect(issue.body).toContain("**Route:** `/r/webb-deep-field`");
    // round-trips: the hidden payload survives for plate/vibe to parse
    expect(parseReviewComment(issue.body)?.route_story).toBe("104");
  });
  it("falls back to route in the title when no story is declared", () => {
    const p = buildPayload({ ...base, routeStory: undefined, prose: "x" });
    const issue = formatLcrIssue({ payload: p });
    expect(issue.title).toContain("/r/webb-deep-field");
    expect(issue.labels).toEqual([LCR_REVIEW_LABEL, VIBE_LABEL]); // no story label
  });
});
