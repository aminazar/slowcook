#!/usr/bin/env bash
# pr-merge-green.sh <pr-number> [merge-flags…] — merge ONLY when every
# check for the CURRENT head sha is complete and zero have failed.
#
# Exists because compound "wait && merge" commands merged past red checks
# twice (slowcook#360, then PR #529's drift-check). The head-sha check
# was added after the gate refused a merge on a STALE run: `gh pr checks`
# reports the last completed run, which after a fresh push is still the
# previous commit's — read as "failed" when the new run hadn't started.
set -euo pipefail
pr="${1:?usage: pr-merge-green.sh <pr-number> [gh pr merge flags…]}"
shift || true

head_sha="$(gh pr view "$pr" --json headRefOid --jq .headRefOid)"
branch="$(gh pr view "$pr" --json headRefName --jq .headRefName)"

# Phase 1: wait for CI to register a run for THIS sha (a push takes a
# few seconds to spawn workflows; without this the gate reads the prior
# commit's verdict).
for _ in $(seq 1 20); do
  if gh run list --branch "$branch" --limit 20 --json headSha --jq '.[].headSha' \
      | grep -q "^${head_sha}$"; then
    break
  fi
  sleep 10
done

# Phase 2: wait for every run on this sha to complete.
for _ in $(seq 1 60); do
  rows="$(gh run list --branch "$branch" --limit 20 \
      --json headSha,status,conclusion,name \
      --jq ".[] | select(.headSha == \"${head_sha}\") | \"\(.status) \(.conclusion) \(.name)\"")"
  if [ -z "$rows" ]; then sleep 10; continue; fi
  if ! grep -qv '^completed ' <<<"$rows"; then break; fi
  sleep 15
done

echo "$rows"
if [ -z "${rows:-}" ]; then
  echo "REFUSING: no CI runs found for head ${head_sha:0:7}" >&2; exit 1
fi
if grep -qv '^completed ' <<<"$rows"; then
  echo "REFUSING: runs still in progress for head ${head_sha:0:7}" >&2; exit 1
fi
if grep -qE '^completed (failure|cancelled|timed_out|action_required)' <<<"$rows"; then
  echo "REFUSING: failed checks on head ${head_sha:0:7}" >&2; exit 1
fi

if [ "$#" -eq 0 ]; then
  exec gh pr merge "$pr" --rebase --delete-branch
fi
exec gh pr merge "$pr" "$@"
