// Client breadcrumbs (0.13.0, evidence-grade since 0.19.0) — a bounded ring
// buffer of what the user's browser just did, so a QA report reconstructs the
// incident WITHOUT a repro. Patches fetch (and, since 0.19.0, XHR) to record
// every API call (method, path, status, the server's X-Request-Id, ms, and —
// dev mode's cheat code — the Server-Timing header, which carries server-side
// db/query timings piggybacked on normal responses). Captures console errors,
// unhandled rejections, route changes and coarse user actions (clicks/submits
// on interactive elements — the free repro script).
//
// BODIES ARE RECORDED ONLY ON FAILURE (status ≥ 400 or a network error), and
// only truncated: the ring runs on a REAL backend in QA mode, and everything
// here may be relayed into a GitHub issue. Authorization/cookie headers are
// never recorded at all.
//
// Custody-safe: nothing leaves the page until the host attaches a tail to a
// report it submits itself.
export interface Breadcrumb {
  t: number; // epoch ms
  kind: "fetch" | "error" | "route" | "mark" | "action";
  msg: string;
  status?: number;
  requestId?: string;
  ms?: number;
  /** Server-Timing header, verbatim — db/query durations the dev backend chose to expose. */
  serverTiming?: string;
  /** Failure evidence only: response body, truncated to BODY_CAP chars. */
  body?: string;
  /** Failure evidence only — or, with `mutationBodies` on, the body of any
   *  non-GET call: the request that triggered it, truncated. */
  requestBody?: string;
  /** 0.20.0 — any X-Debug-* response headers the dev backend chose to emit
   *  (user/tenant/role, cache hit, slowest query…), captured verbatim. */
  debug?: Record<string, string>;
}

export interface RecorderOptions {
  /** Record request bodies for ALL non-GET calls, not just failures — the
   *  last successful mutation is often THE repro input. Opt-in: it carries
   *  the most real data of anything in the tail. */
  mutationBodies?: boolean;
}

const RING = 80;
const BODY_CAP = 2048;
let buf: Breadcrumb[] = [];
let installed = false;
let opts: RecorderOptions = {};
// 0.20.0 — build identity: the backend names itself once via a version-ish
// header; ws/sse traffic is COUNTED by event type, never stored per frame.
let backendVersion: string | undefined;
const wsCounts = new Map<string, number>();

export function backendIdentity(): string | undefined { return backendVersion; }

/** The socket rail's summary — per event-type counts since install. Flushed
 *  into the evidence tail as one synthetic entry; frames are never stored. */
export function socketStats(): Record<string, number> | null {
  return wsCounts.size ? Object.fromEntries(wsCounts) : null;
}

function readDebugHeaders(get: (name: string) => string | null): { debug?: Record<string, string> } {
  // browsers expose no header iteration on XHR and CORS may hide most — probe
  // the conventional names; the dev backend controls what it emits
  const out: Record<string, string> = {};
  for (const h of ["x-debug-user", "x-debug-sql-slowest", "x-debug-sql-count", "x-debug-cache", "x-debug-version"]) {
    const v = get(h);
    if (v) out[h] = v.slice(0, 200);
  }
  const version = get("x-debug-version") ?? get("x-version") ?? get("x-app-version");
  if (version && !backendVersion) backendVersion = version.slice(0, 80);
  return Object.keys(out).length ? { debug: out } : {};
}

export function frameType(data: unknown): string {
  if (typeof data !== "string") return data instanceof ArrayBuffer || ArrayBuffer.isView(data as ArrayBufferView) ? "binary" : "other";
  const t = data.trimStart();
  if (!t.startsWith("{")) return "text";
  try {
    const o = JSON.parse(t) as Record<string, unknown>;
    for (const k of ["type", "event", "kind", "op", "action"]) if (typeof o[k] === "string") return String(o[k]).slice(0, 40);
    return Object.keys(o).slice(0, 3).join(",") || "json";
  } catch { return "text"; }
}

export function pushBreadcrumb(b: Omit<Breadcrumb, "t">): void {
  buf.push({ t: Date.now(), ...b });
  if (buf.length > RING) buf = buf.slice(-RING);
}

export function breadcrumbs(): Breadcrumb[] { return [...buf]; }
export function clearBreadcrumbs(): void { buf = []; }

/** The evidence tail: everything the ring holds from the last `windowMs`
 *  (default 60s) — what a review comment attaches. */
export function breadcrumbTail(windowMs = 60_000, now = Date.now()): Breadcrumb[] {
  return buf.filter((b) => now - b.t <= windowMs);
}

const truncate = (s: string): string => (s.length > BODY_CAP ? s.slice(0, BODY_CAP) + ` …[+${s.length - BODY_CAP} chars]` : s);

/** Read a request body for failure evidence without consuming the caller's
 *  stream. Strings only — streams/FormData are named, not serialised. */
function describeRequestBody(init?: RequestInit, input?: RequestInfo | URL): string | undefined {
  const body = init?.body ?? (typeof input === "object" && input !== null && "body" in input ? undefined : undefined);
  if (body == null) return undefined;
  if (typeof body === "string") return truncate(body);
  if (body instanceof URLSearchParams) return truncate(body.toString());
  return `[${body.constructor?.name ?? typeof body}]`;
}

/** install once — patches fetch + XHR + console.error + rejections + history
 *  + coarse action clicks. Idempotent. */
export function installBreadcrumbRecorder(options?: RecorderOptions): void {
  if (options) opts = { ...opts, ...options };
  if (installed || typeof window === "undefined") return;
  installed = true;

  const origFetch = window.fetch.bind(window);
  window.fetch = async (...args: Parameters<typeof fetch>) => {
    const started = Date.now();
    const url = typeof args[0] === "string" ? args[0] : (args[0] as Request).url ?? String(args[0]);
    const method = (args[1]?.method ?? (typeof args[0] !== "string" ? (args[0] as Request).method : "GET") ?? "GET").toUpperCase();
    try {
      const res = await origFetch(...args);
      // only breadcrumb our own API (avoid noise from assets/3rd-party)
      if (/\/(dash-)?api\//.test(url) || isApiish(url)) {
        const crumb: Omit<Breadcrumb, "t"> = {
          kind: "fetch", msg: `${method} ${path(url)}`, status: res.status,
          requestId: res.headers.get("x-request-id") ?? undefined,
          serverTiming: res.headers.get("server-timing") ?? undefined,
          ms: Date.now() - started,
          ...readDebugHeaders((h) => res.headers.get(h)),
        };
        if (opts.mutationBodies && method !== "GET" && res.status < 400) {
          crumb.requestBody = describeRequestBody(args[1], args[0]);
        }
        // BODIES ON FAILURE ONLY — the response is cloned so the caller's
        // stream is untouched; a body that cannot be read stays unread.
        if (res.status >= 400) {
          crumb.requestBody = describeRequestBody(args[1], args[0]);
          try { crumb.body = truncate(await res.clone().text()); } catch { /* opaque/stream */ }
          pushBreadcrumb(crumb); // pushed after the async read so order ≈ completion
        } else {
          pushBreadcrumb(crumb);
        }
      }
      return res;
    } catch (e) {
      pushBreadcrumb({
        kind: "fetch", msg: `${method} ${path(url)} — network error: ${String((e as Error)?.message ?? e).slice(0, 200)}`,
        requestBody: describeRequestBody(args[1], args[0]), ms: Date.now() - started,
      });
      throw e;
    }
  };

  // XHR — the admin panel's axios and older clients ride this rail, not fetch.
  const XHR = window.XMLHttpRequest;
  if (XHR) {
    const origOpen = XHR.prototype.open;
    const origSend = XHR.prototype.send;
    XHR.prototype.open = function (this: XMLHttpRequest & { __sc?: { m: string; u: string; t0?: number; body?: string } }, method: string, url: string | URL, ...rest: unknown[]) {
      this.__sc = { m: String(method).toUpperCase(), u: String(url) };
      // @ts-expect-error — passthrough of the async/user/password tail
      return origOpen.call(this, method, url, ...rest);
    };
    XHR.prototype.send = function (this: XMLHttpRequest & { __sc?: { m: string; u: string; t0?: number; body?: string } }, body?: Document | XMLHttpRequestBodyInit | null) {
      const sc = this.__sc;
      if (sc) {
        sc.t0 = Date.now();
        if (typeof body === "string") sc.body = truncate(body);
        this.addEventListener("loadend", () => {
          if (!(isApiish(sc.u) || /\/(dash-)?api\//.test(sc.u))) return;
          const crumb: Omit<Breadcrumb, "t"> = {
            kind: "fetch", msg: `${sc.m} ${path(sc.u)}`, status: this.status || undefined,
            requestId: this.getResponseHeader("x-request-id") ?? undefined,
            serverTiming: this.getResponseHeader("server-timing") ?? undefined,
            ms: Date.now() - (sc.t0 ?? Date.now()),
            ...readDebugHeaders((h) => { try { return this.getResponseHeader(h); } catch { return null; } }),
          };
          if (opts.mutationBodies && sc.m !== "GET" && this.status > 0 && this.status < 400) crumb.requestBody = sc.body;
          if (this.status === 0) crumb.msg += " — network error";
          if (this.status >= 400 || this.status === 0) {
            crumb.requestBody = sc.body;
            try { if (this.responseType === "" || this.responseType === "text") crumb.body = truncate(this.responseText); } catch { /* other types */ }
          }
          pushBreadcrumb(crumb);
        });
      }
      return origSend.call(this, body as XMLHttpRequestBodyInit | null);
    };
  }

  const origErr = console.error.bind(console);
  console.error = (...a: unknown[]) => { try { pushBreadcrumb({ kind: "error", msg: a.map(String).join(" ").slice(0, 300) }); } catch { /* ignore */ } origErr(...a); };
  window.addEventListener("unhandledrejection", (e) => {
    pushBreadcrumb({ kind: "error", msg: `unhandled rejection: ${String(e.reason).slice(0, 280)}` });
  });
  window.addEventListener("error", (e) => {
    pushBreadcrumb({ kind: "error", msg: `${e.message} (${e.filename?.split("/").pop() ?? "?"}:${e.lineno})`.slice(0, 300) });
  });

  const record = () => pushBreadcrumb({ kind: "route", msg: location.pathname + location.search });
  const push = history.pushState.bind(history);
  history.pushState = (...a: Parameters<typeof history.pushState>) => { const r = push(...a); record(); return r; };
  window.addEventListener("popstate", record);
  record();

  // THE ACTION TRAIL — the free repro script. Coarse on purpose: interactive
  // elements only, accessible-name-or-tag only, never input values.
  window.addEventListener("click", (e) => {
    const el = (e.target as Element | null)?.closest?.("button, a, [role='button'], input[type='submit'], [data-affordance]");
    if (!el) return;
    const name = el.getAttribute("data-affordance") ?? el.getAttribute("aria-label") ?? (el.textContent ?? "").trim().slice(0, 40) ?? el.tagName.toLowerCase();
    pushBreadcrumb({ kind: "action", msg: `click: ${name}` });
  }, { capture: true, passive: true });
  window.addEventListener("submit", (e) => {
    const f = e.target as HTMLFormElement | null;
    pushBreadcrumb({ kind: "action", msg: `submit: ${f?.getAttribute("aria-label") ?? f?.id ?? f?.action?.split("/").pop() ?? "form"}` });
  }, { capture: true, passive: true });

  // THE SOCKET RAIL (0.20.0) — live updates ride WebSocket/SSE past every
  // HTTP hook, which is exactly where "the UI never updated" bugs hide.
  // Frames are COUNTED by type, never stored: open/close/error land as
  // crumbs, message payloads never leave the page.
  const WS = window.WebSocket;
  if (WS) {
    const Patched = function (this: WebSocket, url: string | URL, protocols?: string | string[]) {
      const ws = protocols === undefined ? new WS(url) : new WS(url, protocols);
      const at = path(String(url));
      pushBreadcrumb({ kind: "mark", msg: `ws open ${at}` });
      ws.addEventListener("close", (e) => pushBreadcrumb({ kind: "mark", msg: `ws close ${at} (${e.code})` }));
      ws.addEventListener("error", () => pushBreadcrumb({ kind: "error", msg: `ws error ${at}` }));
      ws.addEventListener("message", (e) => {
        const t = `ws:${frameType(e.data)}`;
        wsCounts.set(t, (wsCounts.get(t) ?? 0) + 1);
      });
      return ws;
    } as unknown as typeof WebSocket;
    Patched.prototype = WS.prototype;
    Object.assign(Patched, { CONNECTING: WS.CONNECTING, OPEN: WS.OPEN, CLOSING: WS.CLOSING, CLOSED: WS.CLOSED });
    window.WebSocket = Patched;
  }
  const ES = window.EventSource;
  if (ES) {
    const PatchedES = function (this: EventSource, url: string | URL, init?: EventSourceInit) {
      const es = new ES(url, init);
      const at = path(String(url));
      pushBreadcrumb({ kind: "mark", msg: `sse open ${at}` });
      es.addEventListener("error", () => pushBreadcrumb({ kind: "error", msg: `sse error ${at}` }));
      es.addEventListener("message", (e) => {
        const t = `sse:${frameType((e as MessageEvent).data)}`;
        wsCounts.set(t, (wsCounts.get(t) ?? 0) + 1);
      });
      return es;
    } as unknown as typeof EventSource;
    PatchedES.prototype = ES.prototype;
    Object.assign(PatchedES, { CONNECTING: ES.CONNECTING, OPEN: ES.OPEN, CLOSED: ES.CLOSED });
    window.EventSource = PatchedES;
  }
}

function isApiish(url: string): boolean {
  try {
    const u = new URL(url, location.origin);
    // Same-origin, or a local dev backend on another port — never third-party
    // (analytics beacons are noise, and noise in an evidence ring is a leak).
    const local = u.origin === location.origin || /^(localhost|127\.\d+\.\d+\.\d+|\[::1\])$/.test(u.hostname);
    return local && !/\.(js|css|map|png|jpe?g|svg|gif|woff2?|ico|webp|avif)([?#]|$)/.test(u.pathname);
  } catch { return false; }
}

function path(url: string): string { try { return new URL(url, location.origin).pathname; } catch { return url; } }
