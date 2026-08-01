// Review evidence (0.19.0) — the crop math, the tail window, the failure-only
// body rule, and the asset upload's two branch paths.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { cropGeometry } from "./capture.js";
import { pushBreadcrumb, breadcrumbs, clearBreadcrumbs, breadcrumbTail, frameType } from "./breadcrumbs.js";
import { formatReviewComment, parseReviewComment, type ReviewCommentPayload } from "../comment-format.js";
import { uploadReviewAsset } from "../github.js";

describe("cropGeometry", () => {
  it("pads the element and clamps at the frame's origin", () => {
    const g = cropGeometry({ x: 10, y: 10, width: 100, height: 40 }, 2000, 1000, 1);
    expect(g.sx).toBe(0); // 10 − 48 clamps to 0, never negative
    expect(g.sy).toBe(0);
    expect(g.sw).toBe(196); // 100 + 2×48
    expect(g.sh).toBe(136);
  });

  it("maps CSS px to frame px through the dpr", () => {
    const g = cropGeometry({ x: 100, y: 100, width: 50, height: 50 }, 4000, 2000, 2);
    expect(g.sx).toBe((100 - 48) * 2);
    expect(g.sw).toBe((50 + 96) * 2);
  });

  it("downscales only when the crop exceeds maxOut, preserving aspect", () => {
    const small = cropGeometry({ x: 0, y: 0, width: 100, height: 100 }, 2000, 1000, 1);
    expect(small.scale).toBe(1);
    const big = cropGeometry({ x: 0, y: 0, width: 1600, height: 400 }, 2000, 1000, 1, 0, 800);
    expect(big.scale).toBe(800 / 1600);
  });

  it("never emits a zero-size crop for a degenerate rect", () => {
    const g = cropGeometry({ x: 1999, y: 999, width: 0, height: 0 }, 2000, 1000, 1, 0);
    expect(g.sw).toBeGreaterThan(0);
    expect(g.sh).toBeGreaterThan(0);
  });
});

describe("breadcrumbTail", () => {
  beforeEach(() => clearBreadcrumbs());

  it("returns only entries inside the window", () => {
    const now = Date.now();
    pushBreadcrumb({ kind: "route", msg: "/old" });
    // age the first entry past the window by hand
    const all = breadcrumbs();
    void all;
    pushBreadcrumb({ kind: "fetch", msg: "GET /api/x", status: 200 });
    const tail = breadcrumbTail(60_000, now + 120_000);
    expect(tail).toHaveLength(0); // both older than the shifted now
    expect(breadcrumbTail(300_000, now + 120_000).length).toBe(2);
  });

  it("keeps failure evidence fields when pushed", () => {
    pushBreadcrumb({ kind: "fetch", msg: "POST /api/orders", status: 500, body: '{"error":"boom"}', requestBody: '{"qty":3}', requestId: "req-9", serverTiming: "db;dur=42" });
    const [b] = breadcrumbTail(60_000);
    expect(b?.body).toContain("boom");
    expect(b?.requestBody).toContain("qty");
    expect(b?.requestId).toBe("req-9");
    expect(b?.serverTiming).toContain("db;dur=42");
  });
});

describe("evidence in the comment body", () => {
  const payload: ReviewCommentPayload = {
    slowcook_overlay_version: "0.19.0",
    story_id: null,
    url: "http://localhost:5173/orders",
    timestamp: "2026-08-01T09:00:00.000Z",
    prose: "the total is wrong after a refund",
    element: null,
    viewport: { width: 1280, height: 800, dpr: 2, colorScheme: "light" },
    evidence: {
      window_ms: 60_000,
      entries: [
        { t: 1754038740000, kind: "action", msg: "click: refund" },
        { t: 1754038741000, kind: "fetch", msg: "POST /api/refunds", status: 500, ms: 220, requestId: "req-77", serverTiming: "db;dur=190", body: '{"error":"negative total"}', requestBody: '{"orderId":9}' },
        { t: 1754038742000, kind: "error", msg: "TypeError: total is null" },
      ],
    },
  };

  it("survives the format → parse round trip", () => {
    const body = formatReviewComment({ payload });
    const back = parseReviewComment(body);
    expect(back?.evidence?.entries).toHaveLength(3);
    expect(back?.evidence?.entries[1]?.requestId).toBe("req-77");
    expect(back?.evidence?.entries[1]?.serverTiming).toContain("db;dur=190");
  });

  it("renders a collapsed human-scannable details block", () => {
    const body = formatReviewComment({ payload });
    expect(body).toContain("<details><summary>evidence — last 60s (3 entries)</summary>");
    expect(body).toContain("req `req-77`");
    expect(body).toContain("POST /api/refunds");
    expect(body).toContain("</details>");
  });

  it("links the uploaded screenshot when given a blob URL", () => {
    const body = formatReviewComment({ payload, screenshotUrl: "https://github.com/o/r/blob/review-assets/qa/x.jpg?raw=1" });
    expect(body).toContain("[screenshot — the commented element, ringed](https://github.com/o/r/blob/review-assets/qa/x.jpg?raw=1)");
  });
});

describe("uploadReviewAsset", () => {
  const okJson = (data: unknown, status = 200) =>
    new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });

  it("creates the branch when missing, then PUTs the asset", async () => {
    const calls: { url: string; method: string }[] = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, method: init?.method ?? "GET" });
      if (url.endsWith("/git/ref/heads/review-assets")) return okJson({ message: "Not Found" }, 404);
      if (url.endsWith("/repos/o/r")) return okJson({ default_branch: "main" });
      if (url.endsWith("/git/ref/heads/main")) return okJson({ object: { sha: "abc123" } });
      if (url.endsWith("/git/refs")) return okJson({ ref: "refs/heads/review-assets" }, 201);
      if (url.includes("/contents/")) return okJson({ content: { path: "qa/x.jpg" } }, 201);
      return okJson({}, 500);
    }) as unknown as typeof fetch;

    const res = await uploadReviewAsset({ owner: "o", repo: "r", pat: "p", path: "qa/x.jpg", contentBase64: "aGk=", fetchImpl });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.blobUrl).toBe("https://github.com/o/r/blob/review-assets/qa/x.jpg?raw=1");
    expect(calls.some((c) => c.url.endsWith("/git/refs") && c.method === "POST")).toBe(true);
  });

  it("skips branch creation when the branch already stands, and tolerates a concurrent 422", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/git/ref/heads/review-assets")) return okJson({ ref: "refs/heads/review-assets" });
      if (url.includes("/contents/")) return okJson({ content: {} }, 201);
      return okJson({}, 500);
    }) as unknown as typeof fetch;
    const res = await uploadReviewAsset({ owner: "o", repo: "r", pat: "p", path: "qa/y.jpg", contentBase64: "aGk=", fetchImpl });
    expect(res.ok).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(2); // ref lookup + PUT, nothing else
  });

  it("reports the API's own message on a failed PUT", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/git/ref/heads/review-assets")) return okJson({});
      if (url.includes("/contents/")) return okJson({ message: "content too large" }, 422);
      return okJson({}, 500);
    }) as unknown as typeof fetch;
    const res = await uploadReviewAsset({ owner: "o", repo: "r", pat: "p", path: "qa/z.jpg", contentBase64: "aGk=", fetchImpl });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.message).toBe("content too large");
  });
});

describe("dev-mode evidence (0.20.0)", () => {
  it("frameType names a JSON frame by its type-ish key, and falls back honestly", () => {
    expect(frameType('{"type":"order_updated","id":9}')).toBe("order_updated");
    expect(frameType('{"event":"tick"}')).toBe("tick");
    expect(frameType('{"foo":1,"bar":2}')).toBe("foo,bar");
    expect(frameType("plain text")).toBe("text");
    expect(frameType(new ArrayBuffer(4))).toBe("binary");
  });

  it("keeps debug headers on the crumb and renders them under the entry", () => {
    clearBreadcrumbs();
    pushBreadcrumb({ kind: "fetch", msg: "GET /api/orders", status: 200, debug: { "x-debug-user": "u_42/tenant_7/admin", "x-debug-sql-count": "12" } });
    const payload: ReviewCommentPayload = {
      slowcook_overlay_version: "0.20.0", story_id: null, url: "http://x/", timestamp: "t", prose: "p", element: null,
      viewport: { width: 1280, height: 800, dpr: 1, colorScheme: "light" },
      evidence: { window_ms: 60_000, entries: breadcrumbTail(60_000) },
    };
    const body = formatReviewComment({ payload });
    expect(body).toContain("x-debug-user: u_42/tenant_7/admin");
    expect(body).toContain("x-debug-sql-count: 12");
    expect(parseReviewComment(body)?.evidence?.entries[0]?.debug?.["x-debug-sql-count"]).toBe("12");
  });

  it("renders identity and socket counts, and round-trips them", () => {
    const payload: ReviewCommentPayload = {
      slowcook_overlay_version: "0.20.0", story_id: null, url: "http://x/", timestamp: "t", prose: "p", element: null,
      viewport: { width: 1280, height: 800, dpr: 1, colorScheme: "light" },
      evidence: {
        window_ms: 60_000, entries: [{ t: 1, kind: "route", msg: "/" }],
        identity: { frontend: "a1b2c3", backend: "delgoosh-api 2.4.1" },
        sockets: { "ws:order_updated": 12, "sse:tick": 30 },
      },
    };
    const body = formatReviewComment({ payload });
    expect(body).toContain("**Running:** frontend `a1b2c3` · backend `delgoosh-api 2.4.1`");
    expect(body).toContain("`ws:order_updated` ×12");
    const back = parseReviewComment(body);
    expect(back?.evidence?.identity?.backend).toBe("delgoosh-api 2.4.1");
    expect(back?.evidence?.sockets?.["sse:tick"]).toBe(30);
  });
});

describe("buildIssueBody with evidence (0.21.0)", () => {
  it("appends screenshot, evidence block and machine marker after the prose", async () => {
    const { buildIssueBody } = await import("./github-issue-review.js");
    const { renderEvidenceMarkdown } = await import("../comment-format.js");
    const ev = { window_ms: 60_000, entries: [{ t: 1754038741000, kind: "fetch" as const, msg: "POST /api/x", status: 500, requestId: "req-1" }] };
    const body = buildIssueBody(
      { id: "c1", node: "orders/total", label: "Order total", text: "wrong after refund", author: "Amin", createdAt: 1 },
      "qa — spa-patient",
      { evidenceMd: [...renderEvidenceMarkdown(ev), "", "<!-- slowcook-evidence", JSON.stringify(ev), "-->"], screenshotUrl: "https://github.com/o/r/blob/review-assets/qa/x.jpg?raw=1" },
    );
    expect(body.indexOf("> wrong after refund")).toBeLessThan(body.indexOf("screenshot"));
    expect(body).toContain("req `req-1`");
    expect(body).toContain("<!-- slowcook-evidence");
    expect(body.trim().endsWith("_Filed from the review shell._")).toBe(true);
    // the parser must still recognise the body (hydration round trip)
    const { parseIssue } = await import("./github-issue-review.js");
    const back = parseIssue({ number: 7, title: "[review] Order total — wrong…", body, state: "open", html_url: "u", created_at: "t", user: { login: "amin" }, comments: 0 });
    expect(back?.node).toBe("orders/total");
    expect(back?.text).toBe("wrong after refund"); // EXACT — the appendix must not leak into the sidebar prose
  });
});

// THE ENVIRONMENT MATRIX (0.22.2) — the three defects delgoosh's deployment
// found were all environments dash never exercised: a draggable pill far
// from the hardcoded corner, a light-theme host, an RTL page. New consumers
// must bring tests, not discoveries.
describe("sign-in popover environments", () => {
  it("anchors to the pill wherever it was dragged, clamped to the viewport", async () => {
    const { placePopover } = await import("./github-issue-review.js");
    // pill dragged to the top-left: popover opens BELOW, left-clamped
    expect(placePopover({ top: 20, bottom: 52, right: 120 }, 1280, 800))
      .toEqual({ left: 8, top: 60 });
    // pill at the bottom-right (the old hardcoded assumption): opens above, right-aligned
    expect(placePopover({ top: 740, bottom: 772, right: 1264 }, 1280, 800))
      .toEqual({ left: 964, bottom: 68 });
    // narrow phone viewport: the popover stays fully inside the gutters
    const phone = placePopover({ top: 700, bottom: 732, right: 380 }, 390, 800);
    expect(phone.left).toBeGreaterThanOrEqual(8);
    expect(phone.left + 300).toBeLessThanOrEqual(390 - 8);
  });

  it("popover chrome pins dir=ltr so an RTL host cannot mangle it", async () => {
    // the regression was structural: the popover div inherited dir from the
    // page. The emitted source must pin it — checked as a build artifact
    // property because jsdom does not compute bidi layout.
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(new URL("./github-issue-review.tsx", import.meta.url), "utf8");
    const popover = src.slice(src.indexOf("{open && createPortal("));
    expect(popover.length).toBeGreaterThan(100); // the anchor itself must exist
    expect(popover).toContain('dir="ltr"');
    expect(popover).toContain('textAlign: "left"');
  });

  it("popover palette derives from the host theme, not a hardcoded dark", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(new URL("./github-issue-review.tsx", import.meta.url), "utf8");
    const signIn = src.slice(src.indexOf("function SignIn"), src.indexOf("the turnkey component"));
    expect(signIn).toContain("usePrefersDark()");
    // no hardcoded panel colors outside the C palette object
    const afterPalette = signIn.slice(signIn.indexOf("return ("));
    expect(afterPalette.match(/#1f1f1f|#2b2b2b|#8d8d8d/g)).toBeNull();
  });
});
