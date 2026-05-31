#!/usr/bin/env bash
# scripts/changelog-draft.test.sh — smoke test for the generator.
# Runs against this repo's own git history and asserts the output
# shape (header + at least one section + footer). Exits 0 on pass.
#
# Run with: bash scripts/changelog-draft.test.sh

set -euo pipefail

cd "$(dirname "$0")/.."

# Pick a known-good range from this repo's history. v0.19.1 → v0.19.2
# bridges 10 PRs spanning all of: feat, fix, docs. If history changes
# upstream (rebase / squash), update these SHAs.
SINCE=3629195
UNTIL=c79020e

out=$(bash scripts/changelog-draft.sh --since "$SINCE" --until "$UNTIL" --next-version 0.19.2)

# Assertion 1: header present.
echo "$out" | grep -q '^## 0.19.2 — TODO: title$' || {
  echo "FAIL: header missing" >&2
  echo "$out" >&2
  exit 1
}

# Assertion 2: Features section present (the 0.19.1 → 0.19.2 range has feats).
echo "$out" | grep -q '^### Features$' || {
  echo "FAIL: Features section missing" >&2
  echo "$out" >&2
  exit 1
}

# Assertion 3: a known PR is listed (PR #128 — aliases digest).
echo "$out" | grep -q '\[#128\] feat(refresh-knowledge)' || {
  echo "FAIL: PR #128 missing from output" >&2
  echo "$out" >&2
  exit 1
}

# Assertion 4: footer has the right PR count.
echo "$out" | grep -q 'Auto-draft from 10 merged PR' || {
  echo "FAIL: footer PR count wrong" >&2
  echo "$out" >&2
  exit 1
}

# Assertion 5: --help works (and quotes the usage block).
help_out=$(bash scripts/changelog-draft.sh --help)
echo "$help_out" | grep -q 'scripts/changelog-draft.sh' || {
  echo "FAIL: --help didn't render usage" >&2
  echo "$help_out" >&2
  exit 1
}

# Assertion 6: --since with no value + no tag = exit 2 with helpful msg.
# (Skip this if the repo HAS tags — `git describe` would succeed.)
if ! git describe --tags --abbrev=0 >/dev/null 2>&1; then
  err_out=$(bash scripts/changelog-draft.sh 2>&1 || true)
  echo "$err_out" | grep -q 'no tags found' || {
    echo "FAIL: missing --since didn't print helpful error" >&2
    exit 1
  }
fi

echo "PASS  changelog-draft.sh — all assertions green"
