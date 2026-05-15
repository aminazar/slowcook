# Refine Pass B comparison — delgoosh#635 (static analysis)

**Date:** 2026-05-15
**Issue:** [delgoosh/monorepo#635 "Unified login/registration page for patient/therapis, matching the mock"](https://github.com/delgoosh/monorepo/issues/635)
**Baseline cli:** 0.19.0-α.31 (pre-Pass-B; three questions rounds, $3.14 total questions spend)
**Test cli:** 0.19.0-α.36 (Pass B added)
**Method:** static — score each Pass A question against the actual brownfield context the agent had access to.

## TL;DR

| | Round 1 | Round 2 | Round 3 | Total |
|---|---|---|---|---|
| Pass A questions | 3 | 2 | 2 | **7** |
| Would Pass B answer? | 0 | 1 | 1 | **2 (29%)** |
| PM-friction reduction | 0% | 50% | 50% | **29%** |

**Headline finding.** Round 3 Q1 ("What fields does each role's registration collect?") is the **smoking gun**: Pass A's own prose includes "I can infer plausible field sets from the entities" — meaning the model SAW the answer in the brownfield context but asked the question anyway. Pass B is structurally designed to catch exactly this class of failure.

## Per-question scoring

Pass B prompt rules used for scoring:
1. Verbatim question copy
2. Conservative (ambiguous = unanswered)
3. Cite source concretely
4. Style/PM-judgement = always unanswered

### Round 1 (2026-05-14 16:44Z, $0.91)

| # | Question | Pass B verdict | Reasoning |
|---|---|---|---|
| 1 | Is this story for production, mock, or both? (a/b/c) | **UNANSWERED** | Pure scope question. Brownfield can't tell you which mode to run; PM judgement. |
| 2 | Where does unified /login live in production? (a/b/c) | **UNANSWERED** | Architectural decision. No existing `packages/auth-ui`; no precedent in brownfield. PM call. |
| 3 | OTP-only vs separate signup? (a/b/c) | **UNANSWERED** | Mock excerpt could partially inform but the three-way choice is PM scope. |

Round 1 verdict: 0/3 caught. Acceptable — these are scope/architecture questions Pass B is right to leave for PM.

### Round 2 (2026-05-14 16:51Z + 17:05Z, $1.26)

| # | Question | Pass B verdict | Reasoning |
|---|---|---|---|
| 1 | Registration steps per role? (a/b) | **POTENTIALLY ANSWERED** | Mock excerpt is the design source-of-truth (per memory: 8000-char excerpt available). Pass A's prose says "If the mock already has the full registration flow, I'll mirror it verbatim" — meaning the answer IS in scope but Pass A didn't look. |
| 2 | Resume-after-logout: server / client / hybrid? (a/b/c) | **UNANSWERED** | Architectural decision. No existing `registration_step` column in User entity. PM call. |

Round 2 verdict: 1/2 plausibly caught. The hit is exactly the kind Pass B exists for.

### Round 3 (2026-05-14 17:05Z, $0.97)

| # | Question | Pass B verdict | Reasoning |
|---|---|---|---|
| 1 | What fields does each role's registration collect? (a/b/c/d) | **ANSWERED** | `.brewing/context.md` Domain vocabulary section explicitly says: "Patient has User record + Patient profile (birth date, bio, current therapist, tickets balance)" and "Therapist has expertise, status, type, medicalLicenseNumberInIran, rating." Pass A even cites this: "Looking at the entities I can infer plausible field sets." Source citation: `context.md domain vocabulary lines 14-22`. |
| 2 | How is incomplete registration detected? (a/b/c) | **UNANSWERED** | No `registration_step` or `registration_completed_at` column exists in the User entity (verified in entities digest). This is genuinely new schema; PM/architect must pick. |

Round 3 verdict: 1/2 caught. The hit (Q1) is the most damning example — the model literally narrates "I can infer from entities" and still asks the question.

## Why Pass A missed the catches

Round 2 Q1 and Round 3 Q1 are both cases where the model **acknowledged** the answer was in context ("I'll mirror the mock verbatim if it has the flow", "I can infer from entities") but still surfaced them as PM questions. This is a known LLM failure mode under single-pass generation pressure: the model defaults to "ask the human" when uncertain, even when uncertainty is resolvable from supplied context.

Pass B is reflexive — its only job is "answer the question from context" — so it doesn't share the same uncertainty-bias.

## Cost shape (projected)

| | Baseline (α.31) | Test (α.36) | Delta |
|---|---|---|---|
| Round 1 | $0.91 | ~$1.30 (Pass A + Pass B) | +$0.39 |
| Round 2 | $1.26 | ~$1.55 (Pass A + Pass B) | +$0.29 |
| Round 3 | $0.97 | ~$1.20 (Pass A + Pass B) | +$0.23 |
| **Total** | **$3.14** | **~$4.05** | **+$0.91 (+29%)** |
| PM rounds | 3 | 2 (likely) | −1 round |

**Net.** Each extra Pass B call costs ~$0.30. The Round 3 Q1 catch — if Pass B had answered it — likely eliminates the need for Round 3 entirely (the user's answer became part of the spec assumption already). So one Pass B call saves one PM round trip + one Pass A call. **Round 3 alone saves $0.97 by spending $0.23 on Pass B in Round 2.** Net: cheaper, faster.

## Bugs / eval cases discovered

### Bug-ish observation #1 — Pass A's soft-answer pattern is informal Pass B

Pass A already does informal "I'll assume X unless you correct it" — Round 1 has 3 such assumptions, Round 2 has 2, Round 3 has 1. These ARE Pass B's job done informally, but without:
- Concrete source citations
- A structured audit trail
- The discipline of "is this in context or am I guessing?"

Pass B formalizes this. Whether to deprecate the "decisions I've already made" `<details>` block in Pass A's output, or keep both — open question. Lean: keep both; the `<details>` block in Pass A covers PM-judgement assumptions (e.g., "I'll use 60s OTP resend") while Pass B covers brownfield-derivable answers. They're complementary.

### Eval fixture #1 — fields-from-entities catch (HIGH value)

```yaml
# specs/eval-fixtures/refine/brownfield-answer/fields-from-entities.yaml
inputs:
  draft_question: |
    What fields does each role's registration collect, and in what order?
    (a) Patient: firstName + lastName + birthDate, then done
    (b) Patient: name + bio + T&C, then done
    (c) Therapist: name + title + medicalLicenseNumberInIran + expertise + bio + upload license + PENDING
    (d) Something else
  project_context: |
    ## Domain vocabulary
    - Patient — has User record + Patient profile (birth date, bio, current therapist, tickets balance)
    - Therapist — has expertise, status (PENDING/APPROVED/REJECTED), type (GENERAL/SPECIALIST), medicalLicenseNumberInIran, rating
expect_answered: true
expect_source_contains: "domain vocabulary"
```

### Eval fixture #2 — scope question (HIGH value, regression-catcher)

```yaml
# specs/eval-fixtures/refine/brownfield-answer/scope-question.yaml
inputs:
  draft_question: |
    Is this story for production, mock, or both?
    (a) Production only
    (b) Mock only
    (c) Both — mock first, then production
  project_context: |
    [delgoosh context.md verbatim]
expect_unanswered: true   # scope is PM judgement; Pass B must NOT invent an answer
expect_why_contains: "PM judgement"
```

This fixture protects against a future Pass B prompt that over-answers (e.g., picks an option from the codebase mode).

### Eval fixture #3 — schema-not-in-codebase (MEDIUM value)

```yaml
# specs/eval-fixtures/refine/brownfield-answer/schema-needs-add.yaml
inputs:
  draft_question: |
    How is incomplete registration detected on subsequent login?
    (a) registration_completed_at timestamp on users
    (b) Derived from missing fields
    (c) Explicit registration_step enum column
  project_context: |
    [entities digest — User entity has timezone_id, notification_preference_id, roles enum only]
expect_unanswered: true
expect_why_contains: "missing from context"
```

## Recommendations

1. **File the three eval fixtures.** They protect Pass B's calibration as the prompt evolves.
2. **Live A/B on a fresh issue.** Static analysis is suggestive; real run validates. Spend bound: ~$1 (one round of Pass A + Pass B on a fresh issue clone, no follow-up rounds needed since we'd compare draft questions vs the baseline's questions).
3. **Consider extending Pass B to also flag Pass A's informal "I'll assume X" entries.** Pass A's `<details>` block is the audit trail today; Pass B currently only inspects the question list. A future Pass B v2 could audit the assumed-decisions table too — catch "I'll assume password-less login" against the context that explicitly says "no password column exists in users."
