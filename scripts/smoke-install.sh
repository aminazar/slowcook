#!/usr/bin/env bash
# Post-publish smoke-install check.
#
# After publishing one or more @slowcook-ai/* packages, this script
# spins up a clean temp directory and runs `npm install <pkg>@<version>`
# to verify that the published artifact resolves cleanly — i.e. that
# every transitive dep version it references actually exists on npm.
#
# Why: the maintainer publish flow is `pnpm publish` per package, which
# only checks local workspace state. If a workspace `package.json` got
# bumped (e.g. forge-github → 0.11.7) but `pnpm publish` skipped it,
# the cli release happily references `^0.11.7` and uploads fine — but
# `npm install @slowcook-ai/cli` then fails with ETARGET. We hit this
# in May 2026 (slowcook#23) on cli@0.18.0 + cli@0.19.x-alpha.* — both
# wanted forge-github versions that were committed locally but never
# published. Consumers chased an unrunnable cli for ~a week.
#
# Use:
#   scripts/smoke-install.sh                       # smokes every @slowcook-ai/* at @latest + most-recent dist-tag
#   scripts/smoke-install.sh cli                   # only the cli at @latest
#   scripts/smoke-install.sh cli@0.19.0-alpha.16   # specific version
#   scripts/smoke-install.sh --since-publish       # whichever versions match local package.json + dist-tag of the workspace
#
# Exit 0 on success; non-zero if any install failed. Designed for both
# manual maintainer use and CI invocation.

set -euo pipefail

SLOWCOOK_PKGS=(
  cli
  core
  forge-github
  gates
  llm-anthropic
  mock-runtime
  recorder
  review-overlay
  stack-ts
)

NPM="${NPM:-npm}"
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

red()    { printf "\033[31m%s\033[0m\n" "$*"; }
green()  { printf "\033[32m%s\033[0m\n" "$*"; }
yellow() { printf "\033[33m%s\033[0m\n" "$*"; }
dim()    { printf "\033[2m%s\033[0m\n" "$*"; }

usage() {
  cat <<EOF
Usage: $0 [pkg[@version] ...]

Examples:
  $0                            # smoke every @slowcook-ai/* at @latest
  $0 cli                        # only cli@latest
  $0 cli@0.19.0-alpha.16        # specific version
  $0 forge-github cli           # multiple
  $0 --since-publish            # versions matching local workspace package.json
                                # (use right after a publish-pass)

Exit codes:
  0   all targets installed cleanly
  1   one or more failed
  2   bad arguments
EOF
}

# Resolve a package spec to "name@version" using either:
#   - the arg as given (if it contains @)
#   - the latest dist-tag from npm
#   - the local workspace version (if --since-publish)
resolve_spec() {
  local input="$1"
  local from_workspace="$2"
  local short_name version

  if [[ "$input" == *"@"* ]]; then
    echo "@slowcook-ai/${input}"
    return 0
  fi

  short_name="$input"

  if [[ "$from_workspace" == "true" ]]; then
    if [[ -f "${ROOT_DIR}/packages/${short_name}/package.json" ]]; then
      version=$(node -e "console.log(require('${ROOT_DIR}/packages/${short_name}/package.json').version)")
      echo "@slowcook-ai/${short_name}@${version}"
      return 0
    fi
    red "  no workspace package.json for ${short_name}"
    return 1
  fi

  echo "@slowcook-ai/${short_name}@latest"
}

smoke_one() {
  local spec="$1"
  local tmp
  tmp=$(mktemp -d)

  dim "  install dir: ${tmp}"

  local log="${tmp}.log"
  (
    cd "$tmp"
    $NPM init -y >/dev/null
    $NPM install --no-audit --no-fund "$spec" >"$log" 2>&1
  )
  local rc=$?
  if [[ $rc -eq 0 ]]; then
    local short pkg p resolved
    short="${spec#*/}"
    short="${short%@*}"
    pkg="@slowcook-ai/${short}"
    p="${tmp}/node_modules/${pkg}/package.json"
    resolved=$(node -e "console.log(require('${p}').version)" 2>/dev/null || echo "?")
    green "  ✓ ${spec} → resolved as ${resolved}"
    return 0
  fi
  red "  ✗ ${spec} FAILED"
  grep -E "ETARGET|notarget|404|deprecated|No matching" "$log" | head -5 | sed 's/^/      /' || dim "      (full log at $log)"
  return 1
}

main() {
  local from_workspace=false
  local -a targets=()
  local arg

  for arg in "$@"; do
    case "$arg" in
      -h|--help)        usage; exit 0;;
      --since-publish)  from_workspace=true;;
      -*)               usage; exit 2;;
      *)                targets+=("$arg");;
    esac
  done

  if [[ ${#targets[@]} -eq 0 ]]; then
    targets=("${SLOWCOOK_PKGS[@]}")
  fi

  echo "slowcook smoke-install check"
  echo "  npm:    $($NPM --version)"
  echo "  source: $($from_workspace && echo "workspace package.json" || echo "@latest dist-tag")"
  echo "  count:  ${#targets[@]}"
  echo

  local failures=0
  for t in "${targets[@]}"; do
    local spec
    if ! spec=$(resolve_spec "$t" "$from_workspace"); then
      failures=$((failures + 1))
      continue
    fi
    echo "→ ${spec}"
    if ! smoke_one "$spec"; then
      failures=$((failures + 1))
    fi
  done

  echo
  if [[ $failures -gt 0 ]]; then
    red "smoke-install: ${failures} failure(s)"
    yellow "Likely cause: a workspace package.json bump that was committed but not pnpm-published."
    yellow "Fix: republish the missing version(s); see slowcook#23 for the canonical case."
    exit 1
  fi
  green "smoke-install: all ${#targets[@]} target(s) resolve cleanly"
}

main "$@"
