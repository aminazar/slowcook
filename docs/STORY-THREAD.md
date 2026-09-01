# The story-thread rule

*PM ruling, 2026-09-01 (slowcook#558): "I prefer comments all under the
story itself … I prefer all of them be visible (linked/autolinked) under
the issue that represents the story, and then apriori/aposteriori split
questions also asked there."*

One story, one thread. The GitHub issue that represents a story is the
single place a person reads to know everything that has happened to it.
PRs, claims, and reviews carry the detail; the issue carries the story.

## The three obligations

**1. Every decision is asked on the story issue.** Clarifying questions
(S2), sizing questions (#557), multifurcation proposals, brew-halt
choices (#556), and any future "the PM must pick" moment post to the
story issue — never to a PR, never to a side issue. The PM answers
where they were asked; derivations (#554, #556) watch the issue.

**2. Every agent PR cites the story issue in its body.** `#N` in the PR
body makes GitHub cross-link the PR onto the issue's timeline for free.
refine (`Spec refined from #N`), testgen (per-story `(#N)`), brew
(`**Source:** #N`), and the worker's impl PRs (`Closes #N`) all comply;
a new agent PR template must too. Side artifacts that spawn their own
issues (backprop claims) cite the story issue in *their* body
(`**Story thread:** #N`) for the same cross-link.

**3. PR-side state changes echo one line to the issue.** Full reviews,
diffs, and findings stay on the PR — but each state change lands a
one-line, agent-shaped echo on the story issue with a link: taste's
verdict (`taste — APPROVE on #287 · merged`), a resubmit answering a
review (`refine — answered the review on #286`). One line, no detail,
never a repeat.

## Why agent-shaped matters

The worker distinguishes "the PM has spoken" from "the pipeline talked
to itself" by comment SHAPE (`### slowcook` header or a
`<!-- slowcook … -->` marker), because under an operator token every
author looks the same. An echo that forgets the header reads as a human
answer and can open a gate (#556). Every automated comment starts with
`### slowcook ·` or carries a marker. No exceptions.

## What stays off the issue

Line-anchored review comments, iteration logs, diffs, full findings —
anything a reader only needs *after* clicking through. The issue is a
table of contents with verdicts, not a mirror.
