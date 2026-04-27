# @slowcook-ai/review-overlay

> Floating review overlay for slowcook mock previews. PMs leave element-anchored comments by clicking the element; comments POST to the mockup PR via a GitHub PAT. Plate parses them back out for amendments. Ships in slowcook 0.16-α.6.

## What it does

When mounted into the consumer's mock app:

- A floating mode toggle (top-right) shows three modes: **Nav** / **💬 Comment** / **✅ Approve**.
- In **Comment** mode, clicks on any element open a sidebar where the PM types prose. On submit, the overlay POSTs a structured comment to the configured PR.
- In **Approve** mode, the PM clicks an element (or just toggles back to Nav after one click) and the overlay posts an approval comment with a hidden marker that plate detects.
- Each comment carries the element's stable selector (id > data-testid > role+name > tag.classes:nth-child > XPath fallback), bounding box, viewport size + color scheme, current URL, and user agent — both as human-readable markdown AND as a JSON payload inside an HTML comment that plate parses.

The package has TWO entries:

```ts
// Framework-free core (parser, selector, GitHub submit, PAT storage).
// This is what plate imports server-side to decode review comments.
import { parseReviewComment, extractSelector, submitComment } from "@slowcook-ai/review-overlay";

// React shell (mounted into the mock app's root layout).
import { SlowcookReviewOverlay } from "@slowcook-ai/review-overlay/react";
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
