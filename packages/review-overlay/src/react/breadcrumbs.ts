// Client breadcrumbs (0.13.0) — a bounded ring buffer of what the user's
// browser just did, so a QA report reconstructs the incident WITHOUT a repro.
// Patches fetch to record every API call (method, path, status, the server's
// X-Request-Id, ms) and captures console errors + route changes. The QA pill
// attaches the buffer to its report; the investigate agent joins breadcrumbs →
// request ids → server traces. Custody-safe: nothing leaves the page until the
// host sends the report to its own backend.
export interface Breadcrumb {
  t: number; // epoch ms
  kind: "fetch" | "error" | "route" | "mark";
  msg: string;
  status?: number;
  requestId?: string;
  ms?: number;
}

const RING = 80;
let buf: Breadcrumb[] = [];
let installed = false;

export function pushBreadcrumb(b: Omit<Breadcrumb, "t">): void {
  buf.push({ t: Date.now(), ...b });
  if (buf.length > RING) buf = buf.slice(-RING);
}

export function breadcrumbs(): Breadcrumb[] { return [...buf]; }
export function clearBreadcrumbs(): void { buf = []; }

/** install once — patches fetch + console.error + history. Idempotent. */
export function installBreadcrumbRecorder(): void {
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
      if (/\/(dash-)?api\//.test(url)) {
        pushBreadcrumb({ kind: "fetch", msg: `${method} ${path(url)}`, status: res.status, requestId: res.headers.get("x-request-id") ?? undefined, ms: Date.now() - started });
      }
      return res;
    } catch (e) {
      pushBreadcrumb({ kind: "fetch", msg: `${method} ${path(url)} — network error`, ms: Date.now() - started });
      throw e;
    }
  };

  const origErr = console.error.bind(console);
  console.error = (...a: unknown[]) => { try { pushBreadcrumb({ kind: "error", msg: a.map(String).join(" ").slice(0, 300) }); } catch { /* ignore */ } origErr(...a); };

  const record = () => pushBreadcrumb({ kind: "route", msg: location.pathname + location.search });
  const push = history.pushState.bind(history);
  history.pushState = (...a: Parameters<typeof history.pushState>) => { const r = push(...a); record(); return r; };
  window.addEventListener("popstate", record);
  record();
}

function path(url: string): string { try { return new URL(url, location.origin).pathname; } catch { return url; } }
