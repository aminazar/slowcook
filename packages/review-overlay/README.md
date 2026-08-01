# @slowcook-ai/review-overlay

> Floating review overlay for slowcook mock previews. PMs leave element-anchored comments by clicking the element; comments POST to the mockup PR via a GitHub PAT. Plate parses them back out for amendments. Ships in slowcook 0.16-α.6.

## What it does

When mounted into the consumer's mock app:

- A floating mode toggle (top-right) shows three modes: **Nav** / **💬 Comment** / **✅ Approve**.
- In **Comment** mode, clicks on any element open a sidebar where the PM types prose. On submit, the overlay POSTs a structured comment to the configured PR.
- In **Approve** mode, the PM clicks an element (or just toggles back to Nav after one click) and the overlay posts an approval comment with a hidden marker that plate detects.
- Each comment carries a **semantic anchor** (0.10) — `role + accessible name + container path`, computed from the **accessibility tree**: no DOM markers, survives re-renders/reorder, and resolves against the **real product** too (not just the mock). The CSS selector (id > data-testid > role+name > tag.classes:nth-child > XPath) is kept as a fallback. Plus bounding box, viewport size + color scheme, current URL, and user agent — both as human-readable markdown AND as a JSON payload inside an HTML comment that plate parses.

The package has TWO entries:

```ts
// Framework-free core (parser, selector + a11y anchoring, GitHub submit, PAT storage).
// This is what plate imports server-side to decode review comments.
import { parseReviewComment, extractSelector, resolveAnchor, extractA11yPath } from "@slowcook-ai/review-overlay";

// React shells (mounted into the mock app's root layout):
//  - SlowcookReviewOverlay: the LCR mock-review pill (persona/EPSS + selector anchoring).
//  - ReviewWidget: a context-free shell for reviewing STRUCTURED content (PRD/spec/
//    config) — anchors to semantic node ids (data-review-node); configurable label,
//    accent, corner, toggle, accessory.
import { SlowcookReviewOverlay, ReviewWidget } from "@slowcook-ai/review-overlay/react";
```

Mount only the `/react` entry in the consumer's app; the core entry has zero React dependency.

## Mounting in the mock app

The mock app scaffold (`slowcook init mock`) has a placeholder comment in `mock/src/app/layout.tsx`. Replace it with:

```tsx
import { SlowcookReviewOverlay } from "@slowcook-ai/review-overlay/react";

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className="bg-background text-foreground antialiased">
        <ScenarioRegistryProvider registry={registry}>
          {children}
          <SlowcookReviewOverlay
            enabled={process.env["NEXT_PUBLIC_SLOWCOOK_REVIEW"] === "1"}
            owner={process.env["NEXT_PUBLIC_SLOWCOOK_OWNER"] ?? ""}
            repo={process.env["NEXT_PUBLIC_SLOWCOOK_REPO"] ?? ""}
            prNumber={parseInt(process.env["NEXT_PUBLIC_SLOWCOOK_PR_NUMBER"] ?? "0", 10)}
            storyId={process.env["NEXT_PUBLIC_SLOWCOOK_STORY_ID"] ?? null}
          />
        </ScenarioRegistryProvider>
      </body>
    </html>
  );
}
```

The `enabled` gate keeps the overlay out of production-style builds. Slowcook's preview-deploy workflow (0.16-α.5) sets `NEXT_PUBLIC_SLOWCOOK_REVIEW=1` plus the owner/repo/PR env vars when it builds the mock for a `slowcook-mockup` PR.

## Review evidence (0.19.0) — QA mode on a real backend

When the review target is a RUNNING PRODUCT in dev mode (not a mock), turn on
evidence so every comment carries the conditions nobody can reproduce later:

```tsx
<SlowcookReviewOverlay
  enabled={import.meta.env.VITE_SLOWCOOK_REVIEW === "1"}
  owner="…" repo="…" prNumber={/* the QA review issue's number */ 0}
  evidence={{ screenshot: true, networkTail: true }}
/>
```

- **`screenshot`** — tab capture: the browser asks to share the tab ONCE per
  review session, on the first submit. Each comment then carries a CROP of
  the commented element, highlight-ringed with the click marked (whole
  viewport for page-level comments). Small crops ride inline; larger ones
  are committed to a `review-assets` branch in your repo via the Contents
  API and linked.
- **`networkTail`** — the browser's last 60s attached to every comment: API
  calls (method, path, status, duration, `X-Request-Id`, `Server-Timing`),
  request/response bodies ON FAILURE ONLY (2KB-truncated; auth headers are
  never recorded), console errors, unhandled rejections, route changes, and
  a coarse action trail (clicks/submits by accessible name — never input
  values). Rendered as a collapsed `<details>` block and carried in the
  hidden JSON (`payload.evidence`) for machine triage.

**Two middleware lines that make it sing** — in the dev backend:

1. Echo an `X-Request-Id` header per request. The tail records it, so an
   investigating agent joins a pixel complaint to the exact server log lines.
2. Emit `Server-Timing` (e.g. `db;dur=42;desc="7 queries"`). Browsers expose
   it to the recorder, so server-side timings ride along with zero extra
   requests and zero payload risk.

Privacy: this runs against real QA data and relays into GitHub — keep the
target repo private. Failure-body truncation and the auth-header ban are not
configurable off.

## Hosting the built mock — cache headers (required)

When you serve a **statically built** mock (Vite/Next export rsynced to a box, an
S3 bucket, etc.), the HTML shell **must not be hard-cached**, or reviewers keep
seeing a stale mock after every redeploy and your overlay fixes never reach them.

Rule of thumb:

- **`index.html` (and any app shell / chooser) → `Cache-Control: no-cache`** so the
  browser revalidates each load and picks up the newest build immediately.
- **Content-hashed assets (`/assets/*.js`, `*.css`) → long, immutable cache** —
  their filename changes every build, so caching them is safe.

nginx example (mirrors the delgoosh mock at `mock.delgoosh.com`):

```nginx
# hashed build assets are immutable — a new build emits new filenames
location ~* /assets/ {
  expires 30d;
  add_header Cache-Control "public, max-age=2592000, immutable";
}
# app shell — always revalidate so a redeploy is seen on the next load
location = /index.html { add_header Cache-Control "no-cache"; }
location / { try_files $uri $uri/ /index.html; }   # SPA fallback
```

> If a CDN (Cloudflare, etc.) fronts the host, it may apply its own Browser-Cache-TTL
> to cacheable responses — harmless for hashed assets, but make sure the shell stays
> `no-cache` (don't let the CDN cache `index.html`). `slowcook run-mock` already serves
> with no-store dev headers; this note is for **self-hosted static deploys**.

### Live vite **dev**-server mocks behind a CDN — the `?v=` immutable trap

If you serve a **running vite dev server** for review (e.g. `vite --base=/p/`
proxied through nginx + Cloudflare, as the delgoosh box does) instead of a static
build, there's a sharper version of the same trap. Vite serves its **optimized
dependency bundles** at

```
/node_modules/.vite/deps/<dep>.js?v=<hash>
```

with `Cache-Control: max-age=31536000, immutable`. The `?v=<hash>` *looks* like a
content hash but **is not** — vite derives it from the lockfile + config and
**reuses the same `?v` across re-optimizes**, even when a dependency's built
output changed (e.g. you rebuilt the overlay and reinstalled it in place at the
same version). A CDN in front caches that URL **immutably for a year** and keeps
serving the **old** bundle to every reviewer no matter how often you redeploy —
and a hard refresh won't help, because the stale copy lives at the **CDN edge**,
not the browser.

**Symptom:** the box origin serves the new overlay
(`curl http://127.0.0.1:<vite-port>/…/.vite/deps/<dep>.js` shows the new code) but
reviewers still see the old pill/UX through the public URL, with
`cf-cache-status: HIT`.

**Fix:** strip vite's `immutable` and force `no-store` on the dev proxy locations
so the CDN never caches dev bundles:

```nginx
location /p/ {                        # …and /t/, and any other dev SPA
  proxy_pass http://127.0.0.1:5181;
  proxy_hide_header Cache-Control;
  add_header Cache-Control "no-store" always;
  # …proxy_set_header Upgrade / Connection for HMR, etc.
}
```

After adding this, **purge the CDN once** (or publish a new version so the `?v`
changes) to evict any already-poisoned `immutable` entry — `no-store` only
prevents *future* caching, it can't drop a pre-existing immutable hit.

## How a comment lands in the PR

1. PM clicks the floating toggle → **💬 Comment**.
2. Coral tint overlays the viewport; subsequent clicks are captured (`{ capture: true, preventDefault }`) — the underlying button doesn't fire.
3. PM clicks the element they want to comment on. Sidebar opens with the extracted selector pre-filled and a textarea.
4. PM types prose, hits Submit.
5. The overlay reads the GitHub PAT from `localStorage[slowcook.review-overlay.pat.{owner}/{repo}]`. First-time submits prompt for one (token scope: `public_repo` or `repo`).
6. POST to `https://api.github.com/repos/{owner}/{repo}/issues/{pr}/comments` with body:

   ```markdown
   ### Review comment — `#unread-badge`

   **Element:** `span` · "3"
   **Viewport:** 390×844 dark (dpr 3)
   **URL:** http://mock-4015.preview.example.com/u/amin?scenario=017

   > Pin button looks dead.

   <!--
   slowcook:review-overlay
   {"slowcook_overlay_version":"0.1.0","story_id":"017","element":{"selector":"#unread-badge","fallback_selector":"span.badge","strategy":"id","tag":"span","text_hint":"3","bbox":{"x":142,"y":73,"w":22,"h":22}},"viewport":{"width":390,"height":844,"colorScheme":"dark","dpr":3},"url":"...","timestamp":"...","prose":"...","user_agent":"..."}
   -->
   ```

7. Plate (slowcook 0.16-α.7) reads the PR's comments, calls `parseReviewComment(body)` for each, and acts.

## Selector strategy

Stable-selector priority (matches the design doc; first non-null wins):

| Strategy | Example | When it applies |
|---|---|---|
| `id` | `#unread-badge` | Element has a meaningful `id` (skips React `useId` patterns like `:r3:`, Radix's `radix-:r…`, Headless UI's `headlessui-…`) |
| `data-testid` | `[data-testid="save-btn"]` | Element has `data-testid` |
| `role-name` | `button[aria-label="Sign in"]` | Has explicit/implicit role + accessible name (aria-label, aria-labelledby, `<label for>`, button/link textContent) |
| `tag-classes` | `span.badge.counter:nth-child(2)` | Picks first 2 non-utility class names; adds `:nth-child(N)` when parent has multiple same-tag children. Skips Tailwind utilities, emotion `css-XXXX` hashes, CSS-modules `_XXXX` hashes |
| `xpath` | `/html/body/div/span[2]` | Last resort — always works |

The fallback (one rung lower than the chosen strategy) is also captured so plate has a degraded option when the page changes between submit and reconciliation.

## PAT storage

Stored under `localStorage["slowcook.review-overlay.pat.{owner}/{repo}"]`. Scoped per repo — the same browser can hold multiple consumers' tokens without collision.

The PAT never leaves the browser except on a direct fetch to GitHub's API. To revoke / rotate, clear the localStorage entry (or `clearPat(window.localStorage, { owner, repo })` from the console).

A future "Mode B" — consumer-hosted submit endpoint — would let the consumer's backend hold a server-side token instead of the PM's PAT. Deferred.

## Bundle weight

| Entry | Approx gz size |
|---|---|
| `/` (core: parser + selector + github + format) | ~3 KB |
| `/react` (overlay component) | ~6 KB |

No html2canvas yet; α.6 ships the bounding box + selector + viewport metadata and the user can paste a screenshot manually if needed. Auto-screenshot via canvas API queued for a follow-up alpha.

## See also

- [`docs/plans/0.16-mock-app.md`](https://github.com/aminazar/slowcook/blob/main/docs/plans/0.16-mock-app.md) — the architecture this fits into
- [`docs/plans/0.13.1-review-overlay.md`](https://github.com/aminazar/slowcook/blob/main/docs/plans/0.13.1-review-overlay.md) — original design doc; this is its v1 implementation
- [`docs/operating-guide.md`](https://github.com/aminazar/slowcook/blob/main/docs/operating-guide.md) — sets up the SSH preview deploy that delivers the mock app to the PM
