# Testgen frontend conventions (React + Vitest + Testing-Library)

> Conventions for any agent emitting frontend component / route tests via slowcook's vibe / brew loop (or via local-pipeline). These are NOT a `slowcook recipe --frontend` command yet — they're the documented convention so agents have a reference when writing tests for ported UI primitives + routes.
>
> Sister doc: [testgen-backend-conventions.md](./testgen-backend-conventions.md). The shape (when-this-applies → file-layout → patterns) is intentionally parallel.

## When this applies

A story is a candidate for these conventions when ALL of:

- The consumer ships a React SPA (Vite + react-router or Next.js app-router)
- The story touches a UI primitive, a route component, or both
- The consumer already runs vitest with `@testing-library/react` and `@testing-library/jest-dom` (or has them in `devDependencies`)
- The story's brew will add or edit components under `src/components/`, `src/routes/`, or `src/app/`

When the consumer uses a different stack (Solid, Svelte, Vue, plain DOM), the same shape ideas apply but the concrete API differs — re-derive from the consumer's existing component-test pattern.

## File layout (per primitive / per route)

For each component the brew will write:

```
src/components/ui/<Primitive>.tsx          ← @slowcook-stub (impl)
src/components/ui/<Primitive>.test.tsx     ← real failing tests

src/routes/<Route>.tsx                     ← @slowcook-stub (impl)
src/routes/<Route>.test.tsx                ← real failing tests
```

Co-locate the test next to the source (not in a separate `__tests__/` tree) — the project's vitest config already globs `**/*.test.tsx`, and co-location makes the test-implementation pairing obvious to the brew.

## Patterns that earned their place

These are *not* style preferences. Each one is here because skipping it caused a real failure on a real story during dogfood.

### 1. Use accessible-name queries, not bare role selectors

```ts
// ❌ Silently brittle — works as long as exactly one button exists.
const btn = screen.getByRole('button');

// ✅ Survives when other buttons appear later (LanguageToggle,
//    cancel button, header nav, etc.)
const btn = screen.getByRole('button', { name: /send|ارسال کد/i });
```

**Why this matters:** `getByRole('button')` returns the only button if exactly one matches; it throws only when zero or 2+ match. So a test written when the page has one button passes — until a later story adds a header toggle, then the test breaks at runtime and the brew has no clean signal which test to fix. Naming the button at write-time turns "fragile-but-passing" into "robust-and-passing."

**Bilingual repos:** if the SPA renders both fa and en (RTL toggle), use a `/fa-text|en-text/i` regex so the test is locale-independent. The default-language switch costs ~one minute of test-fixing if every test bakes in one language; the regex prevents it entirely.

### 2. Don't refactor existing components to consume newly-extracted primitives in the same PR

When a brew extracts a standalone primitive (`LanguageToggle.tsx`) that an existing component (`Sidebar.tsx`) had inlined, do **not** simultaneously refactor the existing component to consume the new primitive — even though the duplication is annoying.

```
Story A: extract <LanguageToggle> primitive  (PR #41) ← visual parity, new tests
Story B: refactor Sidebar to use it          (PR #42) ← scope-limited DRY pass
```

**Why this matters:** the existing component already has tests that assert against its inlined markup. Changing the markup in the same PR forces a test-rewrite in a PR whose stated scope is "extract primitive," and bisection of any visual regression becomes a guessing game between two unrelated concerns. The DRY pass is a follow-up story.

### 3. When the design system uses element-selectors that don't port to Tailwind, extract a primitive

A design-system source written in plain CSS often relies on element selectors:

```css
/* design-system source */
input, textarea, select {
  border: 1.5px solid var(--brand-sand);
  border-radius: 8px;
  padding: 10px 14px;
}
input:focus { box-shadow: 0 0 0 3px var(--brand-primary-20); }
```

Don't reproduce this with a global Tailwind base layer — it loses to utility-class precedence everywhere, the test suite can't see which styles applied without a real browser, and the brew can't tell when the consumer's component has *opted out* by adding its own classes.

**Better:** extract a `<TextInput>` primitive that carries the styles explicitly + tests for the focus state. The brew can then assert `expect(input).toHaveClass('px-3 py-2 border-brand-sand')` instead of asking the JSDOM whether a global CSS rule applied (it can't).

### 4. Don't mock `window.matchMedia` once — guard at the call site

Tests running in jsdom hit `window.matchMedia is not a function` when a component reads `prefers-color-scheme`. The common fix is a top-level `vi.stubGlobal('matchMedia', …)` in `setup.ts`, but a per-call-site guard is more robust because:

- A new test author won't know the setup is doing this
- Stubs get reset between files (`clearMocks: true` is common); the per-site guard survives
- The runtime app-code stays honest about its environmental assumption

```ts
// component code
const isDark =
  typeof window !== 'undefined' &&
  typeof window.matchMedia === 'function' &&
  window.matchMedia('(prefers-color-scheme: dark)').matches;
```

### 5. Test the placeholder, not the implementation, for backend-blocked routes

Some routes legitimately can't render real UI until backend work lands (notifications stream, AI summaries, credits ledger). The convention:

- The route file renders a `<TodoRoute backend="#770" />` placeholder primitive
- The test asserts the placeholder mounts AND that the linked issue number is visible — not that any of the would-be real UI exists

```tsx
it('shows the backend-blocked placeholder until #770 lands', () => {
  render(<NotificationsRoute />);
  expect(screen.getByTestId('todo-route')).toBeInTheDocument();
  expect(screen.getByText(/#770/)).toBeInTheDocument();
});
```

When the backend lands and brew replaces the placeholder, the failing test is the signal to replace it with real assertions — no risk of forgetting because the test is the deletion site.

## What testgen frontend should NOT do

- Don't snapshot whole route trees (`toMatchSnapshot()`). They go stale on every visual tweak, become noise PRs, and reviewers learn to merge them blindly. Assert specific roles + accessible names instead.
- Don't test design-token values (colour hex, spacing px) from the consumer test suite. Those belong in the design-system package's own tests; the consumer just consumes the tokens.
- Don't test third-party primitives (radix, headless-ui internals). Test the wrapper your code shipped, not the lib.

## Open questions (worth elevating to a slowcook design discussion)

- Should `slowcook recipe --frontend` exist as a sibling to `--backend`? The patterns here are stable enough across React-router + Next-app-router consumers that codifying them is plausible, but the surface (primitive vs route vs hook vs context-provider) is more varied than the NestJS-CQRS quartet (command / query / handler / DTO) — risk of over-fitting.

- Should the placeholder primitive (`<TodoRoute backend="#N" />`) ship as a slowcook-provided component, or stay a per-consumer convention? Today it's per-consumer; centralising would give vibe a known target to scaffold to.
