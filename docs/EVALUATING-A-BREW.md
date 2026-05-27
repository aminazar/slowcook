# Evaluating a slowcook brew PR

When `slowcook brew` opens a PR (`slowcook/brew/story-<id>-<timestamp>`), you (or another reviewer agent) need to validate that what brew shipped **actually matches the story's PM intent + mock shape + spec invariants** — not just "tests pass." Tests can be gamed (regex-matched, mocked, narrowly-scoped); product correctness is the contract.

This doc is a manual QA recipe applicable to any brew PR. Future alphas will auto-emit a story-specific version of this checklist on every brew-PR open.

---

## Quick orientation

Pull the brew PR locally:

```bash
gh pr checkout <brew-pr-number>
# or directly via the branch name from the PR body
git checkout slowcook/brew/story-<id>-<timestamp>
```

Read these three artifacts in order, side-by-side:

1. **The spec** — `specs/story-<id>.yaml` (especially `invariants` + `acceptance_scenarios` + `ui_behavior` + `api_contract`)
2. **The mock** — wherever the story's mock surface lives (e.g., `mock/src/app/...`). This is the design source-of-truth.
3. **The brew diff** — the actual production code shipped. `gh pr diff <brew-pr-number>` or open the PR in the GitHub UI.

Reviewing in that order is critical. Spec first (what was promised), mock next (what it should look like), brew last (what was delivered). Don't read the brew code first or you'll anchor on the implementation and miss spec drift.

---

## Stage 1 — shape evaluation (visual / structural)

For UI stories, **see the rendered output** before reading invariants. The mock dev server is your reference; the production app is what brew shipped.

### Run the mock locally

```bash
pnpm install --frozen-lockfile     # if you haven't already
pnpm -F mock dev                    # serves at http://localhost:3001 (Next default)
# Navigate to the story's mock route — e.g., /patient/appointments
```

If the consumer has the `dev-mock-on-box.sh` wrapper (rotating public URL on a remote runner — see consumer's AGENTS.md), use that for mobile-device QA:

```bash
ssh <agent-user>@<consumer-host> dev-mock-on-box.sh <brew-branch>
# scrape the `url:` line → hand to QA on phone
```

### Run the production-app dev server

The production app lives wherever the spec says — usually `apps/<role>/`:

```bash
pnpm -F <app-name> dev
# e.g., pnpm -F @repo/patient-app dev
# usually serves at http://localhost:3000
```

Navigate to the same route in the production app and **compare side-by-side**:

| Check | Mock | Production (brew output) | Verdict |
|---|---|---|---|
| Layout (logo position, card structure, sidebar) | | | match / drift |
| Brand tokens applied (bg/text/border colors) | | | |
| Typography (sizes, weights, RTL handling) | | | |
| Iconography (SSO logos, emoji, action icons) | | | |
| Spacing + padding (cards, grids) | | | |
| Empty / loading / error states | | | |
| Responsive (mobile, tablet) | | | |
| RTL / LTR direction handling | | | |
| i18n: switch language, verify all copy translates | | | |

**Common shape failures brew tends to produce:**
- Used `bg-red-500` instead of brand token `bg-brand-primary`
- Hard-coded English copy instead of `useLang().t('key')`
- LTR inputs (email) not preserving `dir="ltr"` on RTL pages
- Empty state missing the em-dash convention
- Active nav item styled identically to inactive

---

## Stage 2 — functionality evaluation (behavior + API)

### If the story has `api_contract` entries

Start the real backend:

```bash
pnpm -F <backend-app-name> dev   # e.g., apps/back
# usually serves at http://localhost:3000/api or :4000
```

For each `api_contract` entry in the spec, hit the endpoint manually and verify the response shape:

```bash
# Example: GET endpoint
curl -s -H "Authorization: Bearer $TOKEN" \
  http://localhost:3000/appointment/appointment-by-patient \
  | jq '.'

# Example: POST endpoint with body
curl -s -X POST \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"reason": "test"}' \
  http://localhost:3000/appointment/cancel-appointment/<id>/by-patient \
  | jq '.'
```

Verify:
- Status code matches what the spec promises (200 / 201 / 400 / 401 / 403 / 404)
- Response shape matches the spec's `responses` schema
- Auth gating is enforced (try without token → expect 401)
- Ownership gating is enforced where the spec calls for it (try with another patient's id → expect 403)

### If the story has DB migrations

```bash
pnpm -F <backend-app-name> migration:run
# verify the tables you expected exist
psql $DATABASE_URL -c "\dt" | grep <expected-table>
psql $DATABASE_URL -c "\d <expected-table>"
```

Check:
- Table exists with expected columns + types
- Indices match the spec (e.g., `UNIQUE (patient_id, therapist_id)`)
- FK constraints are present
- Down-migration cleanly reverses (if you have time + a scratch DB)

### Walk through each acceptance scenario

For every entry in `spec.acceptance_scenarios`, manually replay the Given → When → Then:

```
Given an authenticated patient with 2 RESERVED appointments in the future,
  1 COMPLETED appointment in the past, and 1 CANCELLED_OVER_24H_BY_PATIENT,
When the patient navigates to /patient/appointments,
Then the Upcoming tab shows 2 cards, Past shows 1, Cancelled shows 1.
```

Set up the Given state (in the DB or via seed data), perform the When (navigate / click), and check the Then (UI shows the expected count). **If the scenario can't be reproduced because brew didn't wire something** — that's a real gap; don't merge.

---

## Stage 3 — cross-cutting concerns

### Accessibility

```bash
# In the running app, run axe via DevTools or:
pnpm dlx @axe-core/cli http://localhost:3000/<route>
```

For UI brews: zero `serious` or `critical` axe violations on the changed routes. Brew is supposed to satisfy these via the tier-1 a11y test; verify it actually does on the rendered page (not just at the test level).

### Type-check + lint

```bash
pnpm -r typecheck
pnpm -r lint
```

These should pass at the brew-PR head. If they don't, brew shipped broken code — surface that, don't approve.

### Regression check on adjacent stories

```bash
pnpm test    # full suite — should match the brew PR's BASELINE_FULL count
```

Brew's PR description says e.g. `green=16/16`. The local count should match. If not, an iteration was reverted but a regression sneaked through — surface immediately.

---

## Stage 4 — judgment calls

Some things brew can't get right without your eye:

- **Copy quality** — i18n keys with PM-realistic strings? Not "lorem ipsum" or auto-generated placeholders?
- **Loading state UX** — is the spinner well-placed or jarring?
- **Error messages** — actionable + scoped to the form field that failed?
- **Color accessibility** — even if axe passes, does the brand contrast feel right in practice?
- **Mobile feel** — touch targets, scrolling, keyboard behavior
- **Cross-browser** — open in Safari / Firefox if the spec promises browser support

---

## When to fail a brew PR

- ✖ A spec invariant is missing or wrong in the code
- ✖ An acceptance scenario can't be replayed end-to-end
- ✖ Shape (visual) doesn't match the mock for the same viewport
- ✖ API endpoint signature drifts from the contract (paths, status codes, response keys)
- ✖ Production app crashes / blank-page / hydration errors
- ✖ Type-check or lint fails at the brew head

If failure is brew's job to fix (mechanical drift): post a comment naming the gap; `slowcook chef-on-brew-halt` should pick it up if your wiring is in place.

If failure is spec ambiguity (the spec actually allows what brew did): the spec was incomplete; close the brew PR and re-refine the spec instead of fighting brew.

---

## Auto-emitted version (planned for a follow-up alpha)

Future alphas will have brew **auto-emit a story-specific `EVALUATING-STORY-N.md`** on every brew-PR open, populated from the spec yaml. The doc will:

- List every invariant + acceptance scenario with a checkbox
- Pre-build the curl commands from `api_contract`
- Cite the mock file paths from `proposals.routes`
- Note known-fragile areas from `chef-known-fixes.md` so the reviewer pre-checks the trap spots

Until that lands, this generic recipe is the workflow.
