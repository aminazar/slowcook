#!/usr/bin/env bash
# pr-merge-green.sh <pr-number> [merge-flags…] — merge ONLY when every
# check is complete and zero have failed. Exists because compound
# "wait && merge" commands merged past red checks twice (slowcook#360,
# then PR #529's drift-check). Deterministic gate > operator vigilance.
set -euo pipefail
pr="${1:?usage: pr-merge-green.sh <pr-number> [gh pr merge flags…]}"
shift || true
for _ in $(seq 1 40); do
  out="$(gh pr checks "$pr" 2>&1 || true)"
  if ! grep -qi "pending" <<<"$out"; then break; fi
  sleep 15
done
echo "$out"
if grep -qi "pending" <<<"$out"; then
  echo "REFUSING: checks still pending" >&2; exit 1
fi
if grep -q $'\tfail\t' <<<"$out"; then
  echo "REFUSING: failed checks present" >&2; exit 1
fi
if [ "$#" -eq 0 ]; then
  exec gh pr merge "$pr" --rebase --delete-branch
fi
exec gh pr merge "$pr" "$@"
