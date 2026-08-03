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

  it("the sign-in rides AttachedWindow — centered on the pill, dir=ltr, theme-aware", async () => {
    // 0.24.0 — the popover is dash's own: AttachedWindow (portals to body,
    // shares the pill's centre, follows drags). Checked as source properties
    // because jsdom computes neither layout nor bidi.
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(new URL("./github-issue-review.tsx", import.meta.url), "utf8");
    const signIn = src.slice(src.indexOf("function SignIn"), src.indexOf("the turnkey component"));
    expect(signIn).toContain("<AttachedWindow open={open}");
    expect(signIn).toContain('dir="ltr"');                     // chrome pinned ltr inside the window
    expect(signIn).toContain("usePrefersDark()");              // palette follows the host theme
    expect(signIn.slice(signIn.indexOf("return ("))).not.toContain("#1f1f1f");
    // the dash sign-in behaviors, ported whole:
    expect(signIn).toContain("navigator.clipboard?.writeText(flow.userCode)"); // code → clipboard FIRST
    expect(signIn).toContain("copied to your clipboard — paste it on GitHub"); // …and the link gates on it
    expect(signIn).toContain('[["code", "device code"], ["token", "classic token"]]'); // two routes, two tabs
    expect(signIn).toContain("data-screentime");               // the review-time panel exists standard
  });
});

// 0.23.0 — the dash-parity sweep: page-scoped pins and the RTL-proof roots.
describe("dash-parity sweep (0.23.0)", () => {
  it("the issue body carries the pin's route and context, and the route survives hydration", async () => {
    const { buildIssueBody, parseIssue } = await import("./github-issue-review.js");
    const body = buildIssueBody(
      { id: "c1", node: "orders/total", label: "Order total", text: "wrong", author: "A", createdAt: 1, route: "/orders" },
      "qa — spa-patient",
      { context: { url: "http://x/orders?id=9", viewport: "390×844", scheme: "dark" } },
    );
    expect(body).toContain("**Route:** `/orders`");
    expect(body).toContain("**Viewport:** 390×844 · dark mode");
    const back = parseIssue({ number: 3, title: "t", body, state: "open", html_url: "u", created_at: "t", user: { login: "a" }, comments: 0 });
    expect(back?.route).toBe("/orders"); // page-scoped markers need it back
    expect(back?.text).toBe("wrong");    // context lines never leak into prose
  });

  it("both portal roots pin dir=ltr — an RTL host page cannot mangle the chrome", async () => {
    const { readFileSync } = await import("node:fs");
    const shell = readFileSync(new URL("./review-shell.tsx", import.meta.url), "utf8");
    expect(shell).toContain('data-review-widget="" dir="ltr"');
    const overlay = readFileSync(new URL("./overlay.tsx", import.meta.url), "utf8");
    const root = overlay.slice(overlay.indexOf("return createPortal("), overlay.indexOf("return createPortal(") + 400);
    expect(root).toContain('dir="ltr"');
    // reviewer PROSE stays dir=auto — a Farsi comment must type correctly
    expect(shell.match(/<textarea dir="auto"/g)?.length).toBe(2);
  });

  it("a pin files with its route and the marker filter honours it", async () => {
    const { readFileSync } = await import("node:fs");
    const shell = readFileSync(new URL("./review-shell.tsx", import.meta.url), "utf8");
    expect(shell).toContain("route: typeof location");             // recorded at file time
    expect(shell).toContain("!c.route || showsPinsOf(c.route)");   // legacy pins render everywhere; heirs honoured
    expect(shell).toContain("verifyRemote(c.remoteId!)");          // deleted pins get to leave
  });
});

// 0.23.1 — the second parity pass: the rulings only the CODE comments held.
describe("dash-parity sweep 2 (0.23.1)", () => {
  it("route heirs let a moved route keep its pins; focus sync is rate-guarded", async () => {
    const { readFileSync } = await import("node:fs");
    const shell = readFileSync(new URL("./review-shell.tsx", import.meta.url), "utf8");
    expect(shell).toContain("routeHeirs?.[filedOn] ?? [filedOn]");   // no.675, both halves
    expect(shell).toContain('window.addEventListener("focus", onReturn)'); // sync on tab return
    expect(shell).toContain("45_000");                                // …but never bursts GitHub
  });

  it("a signed-out sync says so instead of quietly serving the local archive", async () => {
    const { readFileSync } = await import("node:fs");
    const turnkey = readFileSync(new URL("./github-issue-review.tsx", import.meta.url), "utf8");
    expect(turnkey).toContain('setSyncError("signed out")');
    expect(turnkey).toContain("bottomInset={p.bottomInset}");          // no.588 pass-through
    expect(turnkey).toContain("loadReviewerIdentity(localStorage, coord)?.login"); // pins signed by the signed-in reviewer
  });
});

// THE ABSTRACTION LAW (Amin's ruling, locked): mock-context chrome — walk
// stepper, spotlight, EPSS status — never ships in the abstracted pill. The
// core (pill, sidebar, drafting, attached window, sign-in, evidence, timer)
// is context-free; mock chrome lives host-side or behind a manifest gate.
describe("the abstraction law", () => {
  const strip = (src: string) => src.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");

  it("the QA turnkey contains no mock-context chrome at all", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(new URL("./github-issue-review.tsx", import.meta.url), "utf8");
    expect(src).not.toMatch(/EPSS|spotlight|stepper|walkStep|testingSurfaces/i);
  });

  it("the shell's runtime is EPSS-free (mentions are documentation only)", async () => {
    const { readFileSync } = await import("node:fs");
    const code = strip(readFileSync(new URL("./review-shell.tsx", import.meta.url), "utf8"));
    expect(code).not.toMatch(/EPSS|spotlight|walkStep/);
  });

  it("the overlay's EPSS chrome is gated on a functional manifest, never a default", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(new URL("./overlay.tsx", import.meta.url), "utf8");
    // status line + palette render only with a loaded manifest carrying epics
    expect(src).toContain("surfaceManifest && surfaceManifest.epics.length > 0");
    expect(src).toContain("paletteOpen && surfaceManifest");
    // the surface switcher renders only when surfaces exist
    expect(src).toContain("surfaces.length > 0 && <SurfaceSwitcher");
    // and no manifest URL is ever assumed — explicit prop or env, else nothing
    expect(src).toContain('env("NEXT_PUBLIC_SLOWCOOK_SURFACES_URL") ?? ""');
    expect(strip(src)).not.toContain('"testing-surfaces.json"');
  });
});

// 0.24.1 — the crop finally crops on real products: the SHELL resolves the
// anchor (a11y/fallback schemes included) and hands the rect on the comment;
// the turnkey's attribute lookup was finding nothing on pages with no
// data-review-node, and every screenshot fell back to the whole viewport.
describe("the crop rect comes from the shell (0.24.1)", () => {
  it("the comment carries its anchor rect, resolved at submit by findNodeEl", async () => {
    const { readFileSync } = await import("node:fs");
    const shell = readFileSync(new URL("./review-shell.tsx", import.meta.url), "utf8");
    expect(shell).toContain("const anchorEl = findNodeEl(composer.node);");
    expect(shell).toContain("rect: { x: ar.x, y: ar.y, width: ar.width, height: ar.height }");
    const turnkey = readFileSync(new URL("./github-issue-review.tsx", import.meta.url), "utf8");
    expect(turnkey).toContain("gatherEvidence(c.rect ?? rectForNode(c.node))");
  });
});

// 0.24.2 — delgoosh#886: the crop was attached as a data: URI and GitHub
// displayed NOTHING (data URIs never render in issue markdown); and the tail
// recorded no API calls because the backend lives on a sibling subdomain.
describe("screenshots render and the tail hears the API (0.24.2)", () => {
  it("upload is ALWAYS preferred; inline survives only as the no-upload/failed-upload fallback", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(new URL("./use-evidence.ts", import.meta.url), "utf8");
    const gather = src.slice(src.indexOf("if (upload) {"));
    expect(gather.indexOf("await upload(")).toBeLessThan(gather.indexOf("out.screenshotDataUrl = shot.dataUrl"));
    expect(src).toContain("upload failed — inline beats losing the evidence");
  });

  it("sameSite admits sibling subdomains and localhost, never third parties", async () => {
    const { sameSite } = await import("./breadcrumbs.js");
    expect(sameSite("api.delgoosh.com", "dev-therapist.delgoosh.com")).toBe(true);
    expect(sameSite("delgoosh.com", "dev-therapist.delgoosh.com")).toBe(true);
    expect(sameSite("localhost", "dev-therapist.delgoosh.com")).toBe(true);
    expect(sameSite("evil-delgoosh.com", "dev-therapist.delgoosh.com")).toBe(false); // suffix, not substring
    expect(sameSite("www.google-analytics.com", "dev-therapist.delgoosh.com")).toBe(false);
    expect(sameSite("api.delgoosh.com.attacker.io", "dev-therapist.delgoosh.com")).toBe(false);
  });
});

// 0.24.3 — the chrome leaves the photo: pill, markers, sidebar, comment box,
// attached windows and host chrome all hide for the exposure and come back.
describe("the chrome leaves the photo (0.24.3)", () => {
  it("capture hides every review artifact and restores it in a finally", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(new URL("./use-evidence.ts", import.meta.url), "utf8");
    expect(src).toContain('"[data-review-widget], [data-review-chrome], [data-slowcook-overlay-ui]"');
    expect(src).toContain("await withChromeHidden(() =>");
    expect(src.indexOf("finally")).toBeGreaterThan(0);
    // the settle wait outlives the ~5fps capture stream's frame interval
    expect(src).toContain("CAPTURE_SETTLE_MS = 280");
  });

  it("sidebar, composer and markers live inside the one shell portal the selector hides", async () => {
    const { readFileSync } = await import("node:fs");
    const shell = readFileSync(new URL("./review-shell.tsx", import.meta.url), "utf8");
    // exactly one portal root: everything the shell renders is inside it
    expect(shell.match(/createPortal\(/g)?.length).toBe(1);
    expect(shell).toContain('data-review-widget="" dir="ltr"');
    // and the pill's other slot stamps itself as chrome
    const win = readFileSync(new URL("./attached-window.tsx", import.meta.url), "utf8");
    expect(win).toContain("data-review-chrome");
  });
});

// 0.24.4 — the grip is a full-height rail: it must sit BESIDE the two rows
// (controls + status), not inside the first one.
describe("the grip spans the whole pill (0.24.4)", () => {
  it("grip rail is a sibling of the rows column, and the status row lives inside that column", async () => {
    const { readFileSync } = await import("node:fs");
    const shell = readFileSync(new URL("./review-shell.tsx", import.meta.url), "utf8");
    const grip = shell.indexOf('aria-label="Drag to move"');
    const rail = shell.lastIndexOf('alignItems: "stretch"', grip);
    const column = shell.indexOf('flexDirection: "column", minWidth: 0', grip);
    const statusRow = shell.indexOf("{statusRow && !minimized &&", grip);
    expect(rail).toBeGreaterThan(-1);           // the wrapper stretches its children
    expect(column).toBeGreaterThan(grip);       // the rows column comes AFTER the grip…
    expect(statusRow).toBeGreaterThan(column);  // …and holds the status row
  });
});
