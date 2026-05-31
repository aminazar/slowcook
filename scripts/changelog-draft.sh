#!/usr/bin/env bash
# scripts/changelog-draft.sh — emit a markdown CHANGELOG scaffold
# from merged PRs between two git refs. Pipe to CHANGELOG.md or
# the body of a release PR.
#
# Usage:
#   scripts/changelog-draft.sh                          # since last tag → HEAD
#   scripts/changelog-draft.sh --since v0.19.2          # since v0.19.2 → HEAD
#   scripts/changelog-draft.sh --since v0.19.2 --until HEAD
#   scripts/changelog-draft.sh --next-version 0.19.3    # use as the section header
#
# Output: a markdown section that the maintainer pastes into
# CHANGELOG.md + fleshes out per the existing prose style. Auto-gen
# does the boilerplate (PR list grouped by type); maintainer adds
# the WHY / per-entry context.
#
# Why this is bash, not TypeScript: maintainer-tool, runs once
# per release, no in-process integration with the cli. Bash is the
# shortest path; TS would mean dist/, pnpm install, etc. for one
# script that produces stdout.
#
# Portability: writes to a temp file (compatible with bash 3.x on
# macOS) instead of using associative arrays (bash 4+).

set -euo pipefail

since=""
until_ref="HEAD"
next_version=""
help=0

while [ $# -gt 0 ]; do
  case "$1" in
    --since)        since="$2"; shift 2 ;;
    --until)        until_ref="$2"; shift 2 ;;
    --next-version) next_version="$2"; shift 2 ;;
    --help|-h)      help=1; shift ;;
    *)              echo "unknown arg: $1" >&2; exit 64 ;;
  esac
done

if [ "$help" = "1" ]; then
  sed -n '2,21p' "$0" | sed 's/^# \{0,1\}//'
  exit 0
fi

if [ -z "$since" ]; then
  since=$(git describe --tags --abbrev=0 2>/dev/null || true)
  if [ -z "$since" ]; then
    echo "ERROR: --since not given and no tags found via \`git describe\`." >&2
    echo "Pass --since <ref> explicitly (e.g. --since v0.19.2)." >&2
    exit 2
  fi
fi

# Temp file: each line is "<type>\t<rendered-bullet>"
tmpfile=$(mktemp -t changelog-draft.XXXXXX)
trap 'rm -f "$tmpfile"' EXIT

total=0

emit() {
  printf '%s\t%s\n' "$1" "$2" >> "$tmpfile"
  total=$((total + 1))
}

classify_type() {
  # echo a single-word type from a commit title's conventional-commit prefix.
  local title="$1"
  # Extract conventional-commit type prefix without nested optional groups
  # (bash 3.2 regex is finicky). We match the leading word then check that
  # what follows is `(` or `:`.
  if [[ "$title" =~ ^([a-z]+) ]]; then
    local prefix="${BASH_REMATCH[1]}"
    local rest="${title:${#prefix}}"
    # Strip an optional `(<scope>)`.
    if [[ "$rest" =~ ^\([^\)]*\) ]]; then
      rest="${rest:${#BASH_REMATCH[0]}}"
    fi
    if [[ "$rest" =~ ^:[[:space:]] ]]; then
      printf '%s' "$prefix"
      return
    fi
  fi
  printf 'other'
}

# Walk every commit between since..until and extract PR info.
# GitHub supports three merge styles:
#   - Squash-merge (default): "<title> (#N)" on a SINGLE commit on main.
#   - Merge-commit: "Merge pull request #N from owner/branch\n\n<title>".
#   - Rebase-merge: per-commit titles preserved; no PR ref in subject.
# Most slowcook contributors squash-merge, so we walk ALL commits (not
# just --merges) and try both shapes.
while IFS= read -r line; do
  [ -z "$line" ] && continue
  sha="${line%% *}"
  subject="${line#* }"

  prnum=""
  title=""

  # Squash-merge style: "<title> (#N)" at end of subject.
  if [[ "$subject" =~ \(#([0-9]+)\)$ ]]; then
    prnum="${BASH_REMATCH[1]}"
    # Strip the trailing " (#N)" — preserve everything before.
    title="${subject% (#${prnum})}"
  elif [[ "$subject" =~ ^Merge\ pull\ request\ #([0-9]+) ]]; then
    # Merge-commit: subject is line 1; PR title is on the first
    # non-blank body line.
    prnum="${BASH_REMATCH[1]}"
    title=$(git log -1 --format='%B' "$sha" | awk 'NR==1 {next} NF {print; exit}')
  fi

  if [ -n "$prnum" ] && [ -n "$title" ]; then
    type=$(classify_type "$title")
    emit "$type" "- [#${prnum}] ${title}"
  elif [[ "$subject" =~ ^[a-z]+ ]]; then
    # Direct conventional-commit-shaped push (no PR ref). Rare but
    # possible when the maintainer ff-commits.
    type=$(classify_type "$subject")
    if [ "$type" != "other" ]; then
      short_sha=$(printf '%s' "$sha" | cut -c1-7)
      emit "$type" "- [\`${short_sha}\`] ${subject}"
    fi
  fi
done < <(git log "$since..$until_ref" --format='%H %s' 2>/dev/null || true)

# --- Render ---------------------------------------------------------

if [ -n "$next_version" ]; then
  printf '## %s — TODO: title\n\n' "$next_version"
else
  printf '## TODO: version — TODO: title\n\n'
fi
printf 'Cut TODO-DATE. Bridges %s → %s.\n\n' "$since" "$until_ref"

for type in feat fix docs test refactor perf chore ci build style other; do
  count=$(awk -F'\t' -v t="$type" '$1 == t' "$tmpfile" | wc -l | tr -d ' ')
  if [ "$count" -gt 0 ]; then
    case "$type" in
      feat)     header="### Features" ;;
      fix)      header="### Fixes" ;;
      docs)     header="### Docs" ;;
      test)     header="### Tests" ;;
      refactor) header="### Refactors" ;;
      perf)     header="### Performance" ;;
      chore)    header="### Chores" ;;
      ci|build) header="### CI / Build" ;;
      style)    header="### Style" ;;
      *)        header="### Other" ;;
    esac
    printf '%s\n\n' "$header"
    awk -F'\t' -v t="$type" '$1 == t { print $2 }' "$tmpfile"
    printf '\n'
  fi
done

printf '_TODO: maintainer prose. Auto-draft from %d merged PR(s) between %s and %s._\n' "$total" "$since" "$until_ref"
