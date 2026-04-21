# slowcook — Design

> **Status: active design; 0.1 shipped (frozen-paths enforcement). Full pipeline under active development.** This document describes a TDD-first agentic development pipeline: issue → refined spec → frozen tests → "brewing" (iterated implementation under guardrails) → tiered review → PR merged.
>
> slowcook is forge-agnostic and stack-agnostic by design. 0.1 ships a GitHub forge adapter and a TypeScript stack adapter; other forges (GitLab, Gitea) and stacks (Python, Go) are fast-follows. Consumer projects integrate via `npm install @slowcook-ai/cli` plus a small `.brewing/` config.
>
> [`reworthy/app`](https://github.com/reworthy/app) is slowcook's first consumer and integration-test project.

## 1. Principles

1. **TDD-first.** Tests are written (and human-approved) before any implementation code. Tests are the contract.
2. **Progressive green, ratcheted.** Every implementation iteration must maintain all previously-passing tests and add at least one. Regressions are auto-reverted. No exceptions.
3. **Cheating is a first-class concern.** Frozen tests, manifest checks, reviewer agents, mutation testing, and coverage floors all exist to make test-gaming structurally hard.
4. **Humans review judgment, not correctness.** Mechanical checks and vision models handle objective failures. Humans only see the ~10% that require taste.
5. **Bounded cost.** Every story has a token budget. Semi-infinite loops are detected and halted with a clear forked-road prompt for the human.
6. **Observable and reversible.** Every iteration is a diff with full metadata. Any state can be inspected, reverted, or forked.

## 2. Pipeline overview

```
GitHub Issue
     │ label: needs-refinement
     ▼
┌────────────────────────────────────────────────────────────┐
│ Phase 1 — Refinement Agent                                 │
│  Posts clarifying Qs until spec has no ambiguity.          │
│  Output: specs/story-N.yaml (PR)                           │
└────────────────────────────────────────────────────────────┘
     │ human approves spec PR
     ▼
┌────────────────────────────────────────────────────────────┐
│ Phase 2 — Test-Gen Agent                                   │
│  Produces backend integration + e2e + mechanical tests.    │
│  Records test manifest. Output: tests-only PR.             │
└────────────────────────────────────────────────────────────┘
     │ human approves tests PR → tests frozen
     ▼
┌────────────────────────────────────────────────────────────┐
│ Phase 3 — Brewing Harness (overnight)                      │
│  Parallel lanes × ratcheted iterations                     │
│  ├─ Tier-1 static scan (every iter)                        │
│  ├─ Tier-2 diff reviewer (every checkpoint)                │
│  ├─ Stagnation detection & strategy rotation               │
│  └─ Token budget enforcement                               │
│  Exit: all-green, or halt-with-explanation                 │
└────────────────────────────────────────────────────────────┘
     │ green
     ▼
┌────────────────────────────────────────────────────────────┐
│ Phase 4 — Review Gates                                     │
│  Gate 0.5: Tier-3 reviewer (spec-vs-code, blind to tests)  │
│  Gate 1: Mechanical UI checks                              │
│  Gate 2: AI vision per viewport × scheme                   │
│  Gate 3: Human review (~10% of cases)                      │
└────────────────────────────────────────────────────────────┘
     │
     ▼ PR merged, issue closed
```

## 3. Phase 1 — Story Refinement

**Trigger:** issue labeled `needs-refinement`.

Refinement Agent loops until the spec has zero ambiguities against a fixed checklist:

- Actors & preconditions
- API contract (endpoints, schemas, error cases)
- UI behavior per viewport × color-scheme
- Invariants (things that must remain true regardless of input)
- Acceptance scenarios (Given/When/Then)
- Non-goals (explicit out-of-scope list)

It posts numbered clarifying questions as **one issue comment at a time**. Humans answer inline. When the checklist is satisfied, it emits `specs/story-N.yaml` via a PR against a `specs/` directory.

**Spec schema** (abbreviated):

```yaml
story_id: 42
title: User can react to a rewo with an emotion
actors: [authenticated_member]
preconditions: [...]
invariants: [...]
api_contract: [...]
ui_behavior:
  desktop_light: "..."
  mobile_light: "..."
  mobile_dark: "..."
acceptance_scenarios: [...]
non_goals: [...]
estimate: small    # small ≤4h, medium ≤12h, large → split
token_budget_usd: 5.00
```

The spec PR is **the primary artifact humans review**. Approving it means "the spec correctly captures the story." Human review of the later test PR is a quick confirmation, not a deep read.

## 4. Phase 2 — Test Generation & Freezing

**Trigger:** spec PR merged.

Test-Gen Agent produces three test bundles:

- `tests/integration/story-N.test.ts` — Vitest against real Postgres (testcontainers)
- `tests/e2e/story-N.spec.ts` — Playwright per viewport × scheme
- `tests/mechanical/story-N.json` — declarative Gate-1 rules (dimensions, token conformance, contrast, viewport asserts)

Plus records a **manifest** of every test ID that will run:

```json
{
  "story_id": 42,
  "expected_tests": [
    "tests/integration/story-042.test.ts > POST /api/reactions > creates reaction",
    "tests/integration/story-042.test.ts > POST /api/reactions > rejects 16th reaction with 429",
    ...
  ],
  "baseline_skipped": 0,
  "test_files_sha256": {
    "tests/integration/story-042.test.ts": "abc123...",
    ...
  }
}
```

On merge of the tests PR, everything in the **frozen set** becomes write-protected:

- `tests/**`
- `tests-fixtures/**` (seed data, DB fixtures, mock responses)
- `tests-helpers/**` (custom matchers, setup utilities)
- `vitest.config.*`, `playwright.config.*`, `playwright.fixture.ts`
- `package.json` — only the `scripts.test*` keys (rest remains editable)
- `.github/workflows/tests.yml`
- `.brewing/manifests/story-N.json`

Enforced by:
- Pre-push hook on the VPS runner
- CI check `rewo/frozen-paths-untouched` (blocks PR merge)
- `CODEOWNERS` requires `@rewo-admin` to modify any frozen path (escape hatch with audit trail)

## 5. Phase 3 — The Brewing Harness

### 5.1 Core ratchet

At every iteration:

```
1. Agent proposes a diff.
2. Static scan (Tier 1): regex/AST cheats — revert if matched.
3. Scope check: files outside spec's allowed_paths — revert.
4. Frozen-paths check: any frozen path touched — revert + log violation.
5. Apply diff, run full test suite with fixed invocation.
6. Manifest check:
     - discovered == expected_tests?           else VIOLATION
     - skipped == baseline_skipped?            else VIOLATION
7. Ratchet check:
     - previously_green ⊆ now_green?           else revert (regression)
8. Progress check:
     - now_green ⊃ previously_green?           else stagnation_counter++
9. Tier-2 reviewer on the diff (cheap, ~30s):
     - blocker?                                else revert
10. Checkpoint: commit diff, update green_set.
11. Exit if green_set == all_tests.
```

Violations (steps 4, 6) are stronger signals than regressions. Three consecutive violations → halt the lane; don't just revert.

### 5.2 Graduality and refinement feedback

Graduality — the rhythm of flipping one failing test to green at a time, with a small localized diff — is a first-class concern, not a prompt-level suggestion. It has three properties:

1. **No regressions** — previously-green tests stay green. Handled by the ratchet (§5.1).
2. **Focused progress** — each iteration targets *one* specific red test.
3. **Small, localized diffs** — the change to flip red→green is minimal.

The ratchet alone gives you (1). Properties (2) and (3) require dedicated mechanisms.

#### Target-test selection

The orchestrator picks the next red test as the iteration's **target**, from the frozen manifest, using a simple heuristic (first red test in declared order, biased toward tests in files the agent has already touched in prior iterations). The agent receives:

- The target test (primary goal)
- The full currently-green set (invariants — must stay green)
- The declared `allowed_paths` for this story (scope — cannot touch anything outside)

An iteration is considered successful when the target flips. If the diff incidentally flips other red tests too, that's allowed but logged (see "unexpected wins" below).

#### Diff-size soft cap (not hard)

Each iteration has a **soft cap** on diff size — default `200 lines changed, 5 files touched`, configurable per-story in the spec. Exceeding the cap does **not** auto-reject the diff. Instead, the harness asks the implementer agent to either narrow the diff or provide a **structured justification**:

```json
{
  "reason_category": "new_module | protocol_change | cross_cutting | refactor_needed | other",
  "affected_scope": ["src/api/reactions/", "src/lib/ration/"],
  "narrative": "This test requires a new ration-tracking module that didn't exist. Split across 3 files.",
  "proposed_substories_if_split": [
    "Add ration-tracking module (no behavior change)",
    "Wire ration check into reactions endpoint"
  ]
}
```

With a justification, the diff proceeds through the normal ratchet + reviewer pipeline. An HITL event is emitted (see §7) for asynchronous human review — the brew does **not** block on it.

#### The refinement feedback loop (the whole point)

A big diff is not inherently a brewing failure; it is **evidence that refinement may have under-decomposed the story**. The PM reviews large-iteration events in the dashboard and marks each as one of:

- **"Justified"** — the test genuinely needed a broad change. Story was correctly scoped. Logged for cap calibration.
- **"My bad — refinement miss"** — the story should have been split. The story is halted; the over-broad diff + the agent's `proposed_substories_if_split` are returned to the Refinement Agent (§3) as training/context for re-decomposition. The substories become the inputs for a fresh pass.

Every "my bad" is a learning signal. Over time:
- The Refinement Agent's prompts accumulate counter-examples ("stories of shape X tend to produce over-broad diffs — watch for this pattern")
- The soft cap can be calibrated per stack / per repository based on "justified" distribution
- The rate of "my bad" events is itself a quality metric for refinement

Hard caps would have forced the agent into unnatural narrowing for genuinely-broad changes, producing churn and masking the upstream decomposition problem. Soft caps surface the truth.

#### Unexpected wins

If an iteration flips more than just the target test (e.g., target was test A, but B and C also went green), the harness accepts the diff (green is green) but records an **unexpected-win event**. Consistent patterns of unexpected wins reveal either:

- Good factoring — one change legitimately serves multiple tests (positive signal)
- Redundant tests — several tests asserting the same thing (flag for spec review)
- Over-broad implementation — agent is doing more than its target (reviewer concern)

The Tier-2/3 reviewer inspects unexpected-win iterations with extra scrutiny.

#### Prompt discipline as belt-and-braces

Architectural enforcement is necessary but not sufficient by itself; the implementer agent's system prompt should also embed the expectation:

> "You have been given one target test and a set of allowed paths. Make the smallest change across the fewest files that flips the target from red to green without breaking any currently-green test. Do not refactor. Do not anticipate future tests. If you believe the test genuinely requires a broader change, narrow it as far as possible, then provide a structured justification in the specified schema."

Prompt + cap + justification schema together produce the right behaviour. None of the three alone is enough.

#### Pathspec exclusions

The soft cap applies to files that can affect runtime behaviour. Prose-heavy changes (docs, changelogs, READMEs) would trigger false refinement-feedback cards if counted — they're high-volume, low-risk. Per-project overrides live in `.brewing/graduality.json`:

```json
{
  "diff_soft_cap": { "lines": 200, "files": 5 },
  "exclude_paths": [
    "**/*.md",
    "docs/**",
    "CHANGELOG*",
    "**/README*"
  ]
}
```

The diff analyzer splits changed files into "counted" and "excluded" buckets before applying the cap. Excluded files are still logged in the iteration record — they just don't contribute to graduality signals.

**Conservative defaults** — exclude only what can't affect runtime:

- Markdown docs, `docs/`, `CHANGELOG`, `README` → excluded by default
- **Prompts** → NOT excluded. Prompts are runtime behaviour for LLM-using code. A meta project brewing slowcook itself would want prompts counted.
- **Fixtures, configs, stack.json** → NOT excluded. They affect test outcomes.

Projects may opt in to more exclusions. An agent attempting to smuggle logic into a "docs" file is a non-issue: docs don't execute, so the ratchet catches behaviour drift regardless.

### 5.3 Parallel lanes

Spawn 3 agents on the same story from distinct strategies:

| Lane | Strategy |
|---|---|
| A | Minimal diff, match existing patterns, low temp |
| B | Clean-room, reuse library primitives, medium temp |
| C | Exploratory, higher temp, bolder refactors |

Each in its own git worktree + Docker container. First lane to all-green wins; others terminate. Results in ~2× empirical success rate at ~3× compute cost.

### 5.4 Stagnation escape

When `stagnation_counter ≥ 15`:
1. Revert the lane to its last checkpoint.
2. Rotate strategy (swap system prompt, adjust temp, or fork to a different model).
3. Reset stagnation counter.
4. If stagnation occurs again after rotation → flag as `stuck`, halt for human intervention.

### 5.5 Tiered reviewer agent (anti-gaming)

| Tier | When | Cost | Sees | Focus |
|---|---|---|---|---|
| **Tier 1** | Every iteration | Free (regex/AST) | Diff | Obvious cheat patterns: `NODE_ENV==='test'`, `if (id==='fixture-uuid')`, hardcoded test values |
| **Tier 2** | Every checkpoint | ~$0.05, ~30s (LLM) | Diff only | Is this iteration introducing a smell? |
| **Tier 3** | Once, on all-green | ~$0.50, ~2m (LLM) | Full impl + spec; **tests hidden** | Does the code implement the spec, or just pass the tests? |

**Tier-3 framing is adversarial:**
> "You are a skeptical senior reviewer. The implementer was rewarded for passing tests. Find shortcuts, hardcoded values, spec omissions, and dead code. Cite line numbers and describe a concrete scenario where each finding fails. Do not propose fixes — only describe problems."

Output is structured JSON; blockers force the harness to revert the lane's final checkpoint and re-enter brewing with the findings injected as constraints. Warnings surface in the PR. Nits are logged only.

### 5.6 Periodic mutation audit

Every 10 iterations (and once on final green): harness mutates implementation code (flip bools, swap `>` for `>=`, return null from a non-null function). If the test suite still passes after a mutation → the test was trivial. Flag + escalate. This is the structural check that no agent-driven review can replace.

### 5.7 Coverage floor (and what uncovered code actually tells us)

When an iteration reaches green, any file the agent created or modified must hit ≥80% line coverage under the frozen tests. But **coverage below threshold is not automatically a brewing failure** — it's a signal that one of two things is true:

- The spec missed a case (upstream incompleteness)
- The agent wrote defensive code the spec never asked for (a smell)

Both are *refinement-quality* problems, not brewing-loop problems. Hard-rejecting every coverage gap would force either over-broad testing or overly simple code — both bad outcomes. Instead, the harness surfaces the gap as a non-blocking HITL card, analogous to the large-iteration card in §5.2:

```
Coverage gap — story #42, file src/api/reactions/route.ts

3 branches not covered by any frozen test. Is the spec missing a case,
or is this defensive code OK as-is?

[ Amend spec ]    [ Grant exemption ]    [ Defer ]
```

Resolutions:

- **Amend spec** — opens a draft spec-amendment PR containing test stubs for the uncovered branches. The PM (or test-gen agent, later) fills them in. Once merged, the ratchet re-runs over the affected file.
- **Grant exemption** — records a per-line-range entry in `.brewing/coverage-exemptions.json` with a reason string. Exempted ranges don't count toward the 80% floor. Exemption grants are audit-logged with who/when/why.
- **Defer** — the story can merge, but the card stays open for later audit; appears in the dashboard's "coverage debt" view.

The 80% threshold is a project-configurable default; stricter or looser values live in `.brewing/graduality.json` alongside the diff soft-cap config.

## 6. Token budget & halt conditions

### 6.1 Budget structure

Each story declares `token_budget_usd` in its spec. Default $5. Soft-allocated across phases:

| Phase | Budget share | Notes |
|---|---|---|
| Refinement | 5% | If overrun, spec is too ambiguous — escalate |
| Test-gen | 5% | Rarely overruns |
| Brewing (across all 3 lanes) | 70% | Main spend |
| Tier-2 reviewer | 10% | ~$0.05 × ~150 checkpoints |
| Tier-3 reviewer + mutation | 5% | End-of-lane only |
| Vision / Gate-2 | 5% | Per viewport × scheme × iteration on UI stories |

Every LLM call is tagged with `(story_id, phase, lane, iteration)` and logged to a `brewing_spend` table. Running total tracked live.

### 6.2 Halt conditions (any one triggers halt)

| Trigger | Description |
|---|---|
| `BUDGET_EXHAUSTED` | Total spend ≥ `token_budget_usd` |
| `STAGNATION` | Second stagnation event after strategy rotation (lane is truly stuck) |
| `VIOLATION_STREAK` | 3 consecutive scope or frozen-path violations in a lane |
| `REVIEWER_LOOP` | Same Tier-3 blocker recurs after 3 revert-and-retry cycles |
| `MANIFEST_DRIFT` | Test manifest ≠ discovered tests (possible cheat or flaky runner) |
| `MUTATION_SURVIVAL` | Mutation audit passes too often (tests are tautological) |
| `ITERATION_CAP` | Hard cap (e.g., 200 iterations per lane) |
| `WALL_CLOCK` | Story has been brewing > 12 hours |

Soft warning at 80% of any numeric threshold: dashboard highlights in amber. At 100%: halt.

### 6.3 Halt behavior

On halt:
1. Commit the lane's current state to a `brewing/story-N/halted` branch.
2. Emit a **human-readable halt report** into the dashboard and as an issue comment.
3. Relabel the issue `needs-human-intervention`.
4. The lane's resources are torn down.

Halt report schema — designed for the dashboard UI to render as an actionable card:

```yaml
story_id: 42
halt_reason: REVIEWER_LOOP
halt_timestamp: 2026-04-19T22:14:00Z
iterations_run: 87
checkpoints_committed: 12
tests_green: 14 / 18
tokens_spent_usd: 4.23 / 5.00
summary_plain_english: |
  Reviewer keeps flagging the same issue: when a member has exactly 15
  reactions, the 16th attempt returns 200 (not 429). The agent has
  alternated between two implementations across 3 cycles:
    - A: count-then-insert (race condition)
    - B: insert-then-check (violates constraint)
  Neither handles concurrent requests correctly. Agent appears stuck
  without a pattern it hasn't tried.

last_three_diffs: [shortstat summaries]
last_reviewer_finding: "..."
last_agent_rationale: "..."

suggested_actions:
  - id: pick_approach
    label: "Resolve the forked road"
    description: "The agent can't decide between two approaches. Pick one."
    options:
      - id: approach_a
        label: "Use DB-level atomic insert with unique partial index"
        prompt_prefill: |
          Use Postgres INSERT ... ON CONFLICT with a unique partial
          index scoped to (member_id, week_start). Increment and check
          in a single statement. This is race-safe.
      - id: approach_b
        label: "Use row-level lock + count"
        prompt_prefill: |
          Use SELECT ... FOR UPDATE on the member's reactions for the
          current week, count, then insert if under ration. Wrap in
          a transaction.
  - id: increase_budget
    label: "Give the agent more budget"
    description: "Current spend: $4.23 / $5.00. Adding budget to let it try further."
    param: new_budget_usd
    suggested_value: 8.00
  - id: edit_spec
    label: "Clarify the spec"
    description: "Ambiguity in the spec may be causing this loop."
    action: open_spec_PR
  - id: abandon
    label: "Abandon this story"
    description: "Close the issue or defer to manual implementation."
```

Every halt surfaces **2–4 concrete options**, each with a prefilled prompt. The human clicks one, optionally edits the prompt, and brewing resumes with the chosen path injected as the next iteration's guidance.

**Key rule: never present a halt without at least one forked-road option.** If the harness can't propose concrete options, it's a bug in the halt-reporting logic, not a deficiency to live with.

## 7. HITL dashboard

Standalone Next.js app (`@slowcook-ai/dashboard`). Deployed by the consumer team alongside the orchestrator daemon. Auth is pluggable; the reference deployment uses email-allowlist OAuth.

### Views

**Queue.** Stories in flight, grouped by status (`brewing`, `halted`, `needs-review`, `blocked`).

**Story detail.** For each story:

- Timeline of iterations (one row per iteration):
  ```
  [#42] 19:14  Lane B  +18 / -3 lines in src/api/reactions/route.ts
               tests: 12 green → 13 green (+1: rejects 16th)
               tokens: 1.2k, $0.04
               reviewer: clean
  ```
- Per-lane green progress bar (X / Y tests passing)
- Total spend / budget progress bar
- Last reviewer findings
- Inline screenshots for UI stories, grouped by viewport × scheme
- **Halt card** if halted, rendering the halt report with clickable action options

**Halt intervention UI.** When a story is halted, the action card is the primary interaction:

```
┌────────────────────────────────────────────────────────────┐
│ Story #42 — halted (REVIEWER_LOOP)                         │
│                                                            │
│ [plain-english summary]                                    │
│                                                            │
│ Last attempts:                                             │
│  → attempt A: count-then-insert (race)                     │
│  → attempt B: insert-then-check (violates constraint)      │
│                                                            │
│ Suggested resolution — pick one:                           │
│   ◉ Use ON CONFLICT with partial unique index             │
│   ○ Use FOR UPDATE row-lock + count                       │
│   ○ Write my own hint ▼                                   │
│                                                            │
│ [ Increase budget ($5 → $8) ]                             │
│ [ Edit spec ] [ Abandon ]                                 │
│                                                            │
│        [ Resume brewing with this choice → ]               │
└────────────────────────────────────────────────────────────┘
```

**Gate 3 review.** Screenshots with tldraw annotation tool, expected behavior alongside. Approve / request-changes / annotate per (viewport × scheme) — not per story.

**Large-iteration review.** Non-blocking card per over-cap iteration (see §5.2). Shows diff stats, target test, agent's structured justification, and its `proposed_substories_if_split`. PM marks:

- **Justified** → logged for cap calibration, brew unaffected
- **My bad — refinement miss** → story halted, returned to refinement with the substory proposal as seed context

Large-iteration review is async — reviewing takes seconds per card, and the brew continues while the card awaits disposition. Cards that remain unhandled for N days auto-tag as "justified (no response)" and a reminder fires so cap calibration isn't skewed by PM inaction.

**Spend monitor.** Daily/weekly token spend per story, anomaly alerts when a story exceeds 2× its peer median.

**Audit log.** Every violation, every halt, every human intervention (including large-iteration dispositions) with who+when+what. Forever retained.

**Refinement feedback channel.** "My bad" dispositions feed back into the Refinement Agent (§3) as counter-example context. Over time, the refinement prompts accumulate patterns of "stories of shape X tend to produce over-broad diffs — watch for this" and catch more under-decompositions up front.

## 8. Forge integration (0.1: GitHub; GitLab/Gitea to follow)

slowcook interacts with the forge through a typed `ForgeAdapter` interface (see `packages/forge-github`, future `packages/forge-gitlab`). The labels and workflow below describe the GitHub integration; semantically equivalent mechanisms exist on GitLab and Gitea.

### 8.1 Labels drive the state machine

| Label | Set by | Meaning |
|---|---|---|
| `needs-refinement` | PM or AI triage | Kicks off Phase 1 |
| `spec-ready` | Refinement agent | Spec PR opened |
| `tests-pending` | After spec PR merge | Phase 2 runs |
| `brewing` | After tests PR merge | Phase 3 runs |
| `needs-review` | Harness | Phase 4 — gates triggered |
| `needs-human-intervention` | Harness | Halted; dashboard action required |
| `aesthetic-sensitive` | PM (manual) | Forces Gate 3 HITL regardless of Gate 2 |
| `blocked` | Anyone | Pauses all automation |

### 8.2 Check runs on PRs

Each implementation PR displays a canonical set of checks (prefix is `slowcook/`):

- `slowcook/frozen-paths-untouched`
- `slowcook/scope-compliance`
- `slowcook/manifest-intact`
- `slowcook/tests-integration`
- `slowcook/tests-e2e`
- `slowcook/mutation-audit`
- `slowcook/coverage-floor`
- `slowcook/tier-3-reviewer`
- `slowcook/gate-1-mechanical`
- `slowcook/gate-2-vision`
- `slowcook/gate-3-human` (awaiting / approved / not-required)

Branch protection on `main`: all checks green + 1 human approval.

### 8.3 Self-hosted runner

Consumer projects register a self-hosted GitHub Actions runner on the machine that also hosts the orchestrator daemon (`@slowcook-ai/worker`). Label-change webhooks trigger workflows that invoke the orchestrator. Orchestrator posts status back via check runs, PR comments, issue comments.

Runner needs access to: local Postgres (pg-boss), MinIO (screenshot storage), and Docker (per-lane sandboxes).

## 9. Tech stack

| Layer | Pick | Package |
|---|---|---|
| Orchestrator | TypeScript, Claude Agent SDK | `@slowcook-ai/worker` |
| Core types & logic | Pure TypeScript, no I/O | `@slowcook-ai/core` |
| CLI | Node 20+ | `@slowcook-ai/cli` |
| Job queue | pg-boss on Postgres | (used by worker) |
| Worktrees | Native git worktrees per lane | (in worker) |
| Sandboxing | Docker per lane, restricted outbound | (in worker) |
| Stack adapter (TS) | Vitest + testcontainers; Playwright; Stryker | `@slowcook-ai/stack-ts` |
| Forge adapter (GitHub) | GitHub REST / GraphQL | `@slowcook-ai/forge-github` |
| Screenshot storage | MinIO (S3-compatible), deployed by consumer | (used by worker) |
| Vision review | Claude vision API | (in worker) |
| Dashboard | Next.js, tldraw for annotation | `@slowcook-ai/dashboard` |
| Frozen-path enforcement | CLI + CI + CODEOWNERS | `@slowcook-ai/cli guard` |
| Future: Python stack | Pytest + Coverage.py + mutmut | `@slowcook-ai/stack-python` |
| Future: GitLab forge | GitLab REST | `@slowcook-ai/forge-gitlab` |

## 10. Release roadmap

slowcook ships incrementally. Each version is usable on its own; rewo (and any other consumer) adopts them as they land.

| Version | Scope | New packages | Effort |
|---|---|---|---|
| **0.1** ✅ | `guard` command — frozen-paths enforcement | `@slowcook-ai/core`, `@slowcook-ai/cli` | ~1 day |
| **0.2** ✅ | `manifest record\|verify` — prevents skip/exclude cheating | `@slowcook-ai/stack-ts` (discovery only; Vitest) | ~1 day |
| **0.3** ✅ | `init` — scaffolds consumer `.brewing/*` + CI workflow + CODEOWNERS | (cli growth) | ~1 day |
| **0.4** ✅ | `refine` — issue → structured spec + ratchet (overlap / contradiction / change-of-mind) | `@slowcook-ai/forge-github` | ~1 day |
| **0.4.4** ✅ | polish — remote-branch-aware story ID, label cleanup on change-of-mind, graceful PR-create failure, terminology discipline prompt, consumer `npm ci` in workflow template | (cli + forge-github) | — |
| **0.4.5–0.4.7** ✅ | VERSION drift fix (read from package.json); project-context injection for refinement (`.brewing/context.md`); label lifecycle polish (`spec-submitted` on PR open → `spec-ready` on merge); strip trailing assistant turns before LLM call | (cli) | — |
| **0.5** ✅ | `testgen` — spec → Vitest integration tests; idempotent; on `push` to main touching `specs/story-*.yaml`; auto-applies `override-freeze` + removes superseded tests when a spec has `supersedes:` | (cli) | ~1 day |
| **0.5.1** ✅ | `catchup` — detects state drift across the pipeline (pending refinements / on-spec-merged / testgen) and runs the auto-runnable ones. Primary user-facing entrypoint for fixing "trigger missed" states without artificial comment-pokes. New `ForgeAdapter` methods: `listIssuesByLabel`, `findPullRequestByBranch`. | (core + forge-github + cli) | — |
| **0.6** ✅ | `brew` — single-lane ratcheted implementation loop. Baseline test run → per-iteration agent turn (read_file/write_file/list_directory tool use) → test run → ratchet (revert regression, revert no-progress, commit only checkpoints) → halt on budget/iteration/stagnation/wall-clock with structured JSON report posted as issue comment. Token-budget tracking (approx Opus/Sonnet/Haiku pricing with cache accounting). Graduality soft-cap (200 lines / 5 files) with structured `justify_diff_overflow` tool. Frozen-path + allowed-path enforcement at the diff level (not just the guard). | (stack-ts `runTests` + cli `brew`) | ~1 day |
| **0.6** | `brew` — single-lane ratchet, budget, pg-boss, halt schema, **graduality mechanisms (target-test selection, diff soft-cap, justification schema)** per §5.2 | `@slowcook-ai/worker` | ~5 days |
| **0.7** | Parallel lanes | (worker growth) | ~1 day |
| **0.8** | Tier-1 static scan + Tier-2/Tier-3 reviewer + mutation audit + coverage floor | (worker growth) | ~2 days |
| **0.9** | Gate 1 mechanical (UI asserts) + Gate 2 vision | (stack-ts + worker growth) | ~3 days |
| **1.0** | HITL dashboard (incl. halt cards + **large-iteration cards + refinement feedback channel** per §7), end-to-end pipeline validated on rewo | `@slowcook-ai/dashboard` | ~5 days |

**Total to 1.0:** ~25 days. First-useful milestone (0.1 → 0.3): ~4 days — consumers can already enforce frozen paths + manifests, and scaffold new projects. Graduality mechanisms land with the first brew release (0.6) so they shape behavior from the first real iteration.

## 11. Risks

| Risk | Mitigation |
|---|---|
| Spec quality ceiling | Refinement agent is the highest-leverage component. Budget prompt-iteration time specifically for it. |
| Test-gaming via new categories | Add patterns to Tier-1 scanner as discovered. Mutation audit is the backstop. |
| Reviewer rubber-stamps | Adversarial framing + evidence-required findings + spec-blind-to-tests view. |
| Parallel lanes cost | Measured per-story; stop a lane early if another crosses 80% green first. |
| Token runaway in loops | Budget + halt triggers (section 6). |
| Halt options become "just give up" | Rule: every halt must propose ≥1 concrete forked-road action. Enforced by halt-report schema. |
| Orchestrator host SPOF | Recommend nightly off-box backup of brewing state + worktrees for any consumer self-hosting `@slowcook-ai/worker`. |
| Green on false premise (spec wrong) | Human-gated spec PR is the sole defense. Keep that review honest; mutation audit partially helps. |

## 12. What's out of scope for 1.0

- Multi-repo stories (one PR spanning multiple repos)
- Cross-service integration stories (microservices coordination)
- Architecturally novel stories (new patterns not yet in the codebase) — route to human implementation for now
- Database migration work — tooling for this is a separate concern
- Non-GitHub forges (GitLab adapter lands post-1.0 as `@slowcook-ai/forge-gitlab`)
- Non-TS stacks (Python lands post-1.0 as `@slowcook-ai/stack-python`)
- Brownfield bootstrap command (see §13.2)

## 13. Adoption paths

### 13.1 Greenfield (default)

slowcook was designed assuming a fresh TDD-friendly project: issues → refinement → frozen tests → brewing. Everything above describes this flow. This is the 1.0 target.

### 13.2 Brownfield (post-1.x)

Existing projects with low or zero test coverage can still adopt slowcook, with caveats:

- **Immediately usable in any project**: `slowcook init`, `slowcook guard`, and `slowcook manifest` don't require any existing tests. They protect whatever is there from the moment they're installed.
- **Brewing needs seed tests**: the ratchet is meaningless without a manifest of tests that express real behaviour. You can't ratchet from zero.

The bootstrap path for an existing low-coverage project:

1. `slowcook init` — configuration in place.
2. Identify 3–5 critical user journeys that currently lack tests. Write seed tests manually.
3. `slowcook manifest record` — captures the seed.
4. New work flows through the normal pipeline; the test set grows organically as stories land.

**Planned (post-1.0): `slowcook bootstrap`** — interactive walkthrough for brownfield:

- Scans the codebase, surfaces untested hot paths (ranked by git churn × LOC).
- PM picks which deserve seed tests first.
- An assist agent drafts characterization tests that pass against current behaviour; PM reviews and commits.
- Hands off to normal refinement flow for net-new work.

**Honest limitation.** slowcook is not a rescue tool for legacy codebases with no architectural coherence. The ratchet requires something meaningful to ratchet. Slowcook multiplies disciplined projects; it doesn't rescue chaotic ones.

## 14. Agent prompt evaluation

Prompts, models, temperature, and system instructions drive every agent's behaviour. Keeping them right as they evolve matters — a silent prompt regression can degrade spec quality for weeks before anyone notices. Slowcook's approach has three tiers:

### 14.1 Tier 1 — shape invariants (always on, free)

Every agent's LLM output is validated against a strict schema (Zod) before any downstream action. Malformed output fails loudly in place.

Examples already shipping:
- `REFINEMENT_ANALYST` must produce either a markdown question-list OR a YAML spec matching `EmittedSpecSchema`. Both are validated at `parseAgentOutput` time.
- `RELATIONSHIP_ANALYST` must produce strict JSON matching `VerdictSchema`. Parsed via `parseVerdict`.

This catches "the prompt broke and now outputs are invalid" the instant it happens.

### 14.2 Tier 2 — curated corpus (on-demand, $$)

A benchmark suite of curated inputs with known-good expected behaviour, run before any prompt change. Lives in the slowcook repo, not per-consumer:

```
packages/cli/eval/refinement/
├── case-001-simple-happy-path/
│   ├── issue.md
│   ├── expected.yaml
│   └── rubric.yaml    # keywords to expect, patterns to reject
├── case-002-ambiguous-issue-needs-questions/
├── case-003-prompt-injection/
├── case-004-overlap-with-prior-spec/
└── case-005-change-of-mind-contradiction/
```

Invoked as `slowcook eval --corpus refinement --runs 3`. Executes every case N times, computes per-case pass/fail plus aggregates, outputs a report. **Not part of CI** — run manually after prompt edits, or nightly against a golden set.

### 14.3 Tier 3 — aggregate metrics (periodic)

On top of per-case pass/fail, aggregate metrics surface gross degradations:

| Metric | What it catches |
|---|---|
| Schema compliance rate | Prompt regressions that produce invalid output |
| Ask-or-emit discipline | Agent emits a spec when it should have asked more |
| Checklist field coverage | Emitted specs missing required fields |
| Adversarial pass rate | Prompt injection, off-topic drift |
| Inter-run stability (temp 0.2, 5 runs) | How often do outputs agree on key fields — proxy for reliability |
| Tokens per refinement | Chattiness drift |
| Rounds-to-spec distribution | Agent converging or thrashing? |

### 14.4 The honest limit

Metrics catch **gross** degradations, not subtle quality issues. Prompt V2 that drops schema compliance from 98% → 85% is caught instantly. Prompt V2 that asks technically-correct-but-less-insightful questions slips through every automated check.

The three-layer composition:

- **Metrics = regression guard** (automate, cheap)
- **Human review = quality arbiter** (periodic, judgment-based)
- **"My bad" cards from real refinements** (§5.2) = ground-truth production feedback

The loop closes itself: metrics prevent silent prompt regressions, human review keeps improving the bar, and HITL disposition of real brewing sessions feeds back into prompt iteration.

---

This is the canonical design doc. Implementation notes per release live in the package READMEs (`packages/*/README.md`).
