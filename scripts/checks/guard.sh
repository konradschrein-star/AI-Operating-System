#!/usr/bin/env bash
#
# guard.sh — the ONE pre-merge gate for this repo. One command, clear
# PASS/FAIL/SKIP, and for every FAIL: the exact file:line and what to do
# about it. Built for project aios-devenv-and-cli, night of 2026-08-22/23,
# when ~10 lanes were editing this repo in parallel — this is what stands
# between that and a broken `main`.
#
# It does NOT reimplement the checks it runs. Every phase below shells out
# to a script that already existed (no-raw-colours.cjs, dollar-sweep.sh,
# check-instrument-typecheck.sh, gates-808.sh) or to `tsc`/`pnpm build`
# directly. guard.sh is the aggregator, the timing budget, and the summary
# — nothing here re-derives what those scripts already decide.
#
# USAGE
#   bash scripts/checks/guard.sh                # = --fast
#   bash scripts/checks/guard.sh --fast          # phases 0-2, no build, no
#                                                 # scripts/checks typecheck,
#                                                 # no functional suite.
#                                                 # Budget: well under a
#                                                 # minute on an idle box.
#   bash scripts/checks/guard.sh --full          # everything (phases 0-4).
#                                                 # Minutes, not seconds —
#                                                 # this is the one to run
#                                                 # before an actual merge.
#   bash scripts/checks/guard.sh --full --json   # machine-readable report
#   bash scripts/checks/guard.sh --strict        # also fail on any SKIP —
#                                                 # nothing may be silently
#                                                 # skipped (CI's flag)
#
# EXIT CODE. Unlike gates-808.sh (a recorder that only fails with --strict),
# guard.sh IS the gate: it exits non-zero the moment any check FAILs, with
# or without --strict. --strict raises the bar further — a SKIP (e.g. a
# check that needs a live Postgres and none is configured) also fails the
# run. Use --strict wherever "may this merge" is being decided by a machine
# rather than read by a human.
#
# Run this from an agent's worktree, not just by a human at a terminal —
# every phase below is a plain command with a real exit code, nothing here
# depends on a TTY.

set -uo pipefail   # NOT -e — one red phase must not stop the rest (gates-808.sh's rule; a check that can abort the run before printing its own verdict is worse than one that is merely red).

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO"

MODE="fast"
STRICT=0
JSON_OUT=0
for arg in "$@"; do
  case "$arg" in
    --fast) MODE="fast" ;;
    --full) MODE="full" ;;
    --strict) STRICT=1 ;;
    --json) JSON_OUT=1 ;;
    -h|--help)
      sed -n '1,33p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      echo "guard.sh: unknown flag '$arg' (expected --fast|--full|--strict|--json)" >&2
      exit 2
      ;;
  esac
done

# ── result table (parallel arrays; bash has no struct) ──────────────────────
PHASES=(); NAMES=(); STATUSES=(); DURATIONS=(); DETAILS=(); FIXES=(); RAWOUT=()

record() {
  PHASES+=("$1"); NAMES+=("$2"); STATUSES+=("$3"); DURATIONS+=("$4"); DETAILS+=("$5"); FIXES+=("$6")
  RAWOUT+=("${7:-}")
}

# Pull the one line out of a check's output that actually says where it
# broke. Tried in order of specificity; falls back to the last non-blank
# line (every script here ends on its own verdict line).
extract_detail() {
  local out="$1" line
  line="$(printf '%s\n' "$out" | grep -m1 -E 'error TS[0-9]+' || true)"
  if [ -n "$line" ]; then printf '%s' "${line#"${line%%[![:space:]]*}"}"; return; fi
  line="$(printf '%s\n' "$out" | grep -m1 -E '^[[:space:]]*(FAIL|UNLISTED)[[:space:]]' || true)"
  if [ -n "$line" ]; then printf '%s' "${line#"${line%%[![:space:]]*}"}"; return; fi
  line="$(printf '%s\n' "$out" | grep -oE '[A-Za-z0-9_./-]+\.(ts|tsx|cjs|mjs|js|css|sh):[0-9]+' | head -1 || true)"
  if [ -n "$line" ]; then printf '%s' "$line"; return; fi
  printf '%s\n' "$out" | grep -v '^[[:space:]]*$' | tail -1
}

# run_check <phase> <name> <fix-hint-on-fail> <shell command>
# Mirrors gates-808.sh's gate_sh: `bash -c` with pipefail set INSIDE that
# subshell only, so a `cmd | tail -N` here cannot report tail's exit code
# instead of cmd's (round 1353's finding — see AI OS memory
# dollar-sweep-spent-false-positive / gates-808-is-the-repo-suite).
run_check() {
  local phase="$1" name="$2" fix="$3" script="$4"
  local start end dur out code detail
  start=$(date +%s)
  out="$(bash -c "set -o pipefail; $script" 2>&1)"
  code=$?
  end=$(date +%s)
  dur=$((end - start))
  if [ "$code" -eq 0 ]; then
    record "$phase" "$name" "PASS" "$dur" "" "" "$out"
  else
    detail="$(extract_detail "$out")"
    record "$phase" "$name" "FAIL" "$dur" "$detail" "$fix" "$out"
  fi
}

skip_check() { record "$1" "$2" "SKIP" "0" "$3" ""; }

# ═══════════════════════════════════════════════════════════════════════════
# PHASE 0 — preflight
# ═══════════════════════════════════════════════════════════════════════════

node_ver="$(node --version 2>/dev/null || echo v0.0.0)"
node_major="${node_ver#v}"; node_major="${node_major%%.*}"
if [ "${node_major:-0}" -ge 22 ] 2>/dev/null; then
  record 0 "node-version" "PASS" 0 "" ""
else
  record 0 "node-version" "FAIL" 0 "found ${node_ver}, need v22+" \
    "install/select Node 22+ (nvm install 22 && nvm use 22), then re-run"
fi

# devDependencies check. `pnpm install --frozen-lockfile` under this
# environment's NODE_ENV=production silently PRUNES devDependencies —
# typescript included — and still exits 0 / prints "Already up to date".
# The only reliable signal is whether tsc is actually on disk afterwards.
# See AI OS memory pnpm-prod-prune-reads-as-success.
check_devdeps() {
  local pkg="$1"
  if [ -x "$REPO/$pkg/node_modules/.bin/tsc" ]; then
    record 0 "devdeps-$pkg" "PASS" 0 "" ""
  else
    record 0 "devdeps-$pkg" "FAIL" 0 "$pkg/node_modules/.bin/tsc is missing" \
      "cd $pkg && pnpm install --frozen-lockfile --prod=false  — NEVER bare --frozen-lockfile here: under NODE_ENV=production it removes typescript/tsx and exits 0 doing it"
  fi
}
check_devdeps forge-control
check_devdeps forge-control-web

# ═══════════════════════════════════════════════════════════════════════════
# PHASE 1 — static rules & token purity
# ═══════════════════════════════════════════════════════════════════════════

run_check 1 "no-raw-colours" \
  "replace the literal with a token from forge-control-web/app/tokens.ts; if it genuinely cannot go through the cascade (WebGL/canvas/image export), add a scoped FILE<TAB>ERE<TAB>REASON line to scripts/checks/raw-colour-allowlist.txt" \
  "node scripts/checks/no-raw-colours.cjs"

run_check 1 "dollar-sweep" \
  "remove the currency-shaped literal from forge-control-web/app (Konrad runs on subscription, not API billing — a rendered \$/€ number is a defect, not a style nit); if it is a real, reviewed exception, add a scoped line to scripts/checks/dollar-allowlist.txt" \
  "bash scripts/checks/dollar-sweep.sh"

# Unowned/forbidden-file diff guard. Tonight's house rules name a fixed set
# of shared files no lane may touch without an explicit brief: the desktop
# shell, the nav registry, the shared token/theme CSS, and the engine core.
# A stray edit to any of these is a merge conflict nobody is awake to
# resolve — this is the automated version of that rule, scoped to
# main...HEAD (three-dot: this branch's own commits, not main's since we
# diverged — see AI OS memory two-dot-diff-shows-sibling-work-reversed).
FORBIDDEN_RE='(^|/)app/desktop/DesktopApp\.tsx$|(^|/)app/desktop/nav-items\.ts$|(^|/)app/tokens\.ts$|(^|/)app/globals\.css$|(^|/)app/theme\.css$|(^|/)app/v2\.css$|project-tick|cc-runner|executor\.ts|db/projects|VaultFileList|routes/files'
if git rev-parse --verify main >/dev/null 2>&1; then
  fstart=$(date +%s)
  hits="$(git diff --name-only main...HEAD 2>/dev/null | grep -E "$FORBIDDEN_RE" || true)"
  fdur=$(( $(date +%s) - fstart ))
  if [ -n "$hits" ]; then
    record 1 "forbidden-file-diff" "FAIL" "$fdur" "$(printf '%s' "$hits" | head -1)" \
      "this file is shared/engine infrastructure owned by another lane — revert your edit here (git checkout main -- <file> only if you are certain nobody else's uncommitted work touches it) and write the needed change into HANDOFF.md instead"
  else
    record 1 "forbidden-file-diff" "PASS" "$fdur" "" ""
  fi
else
  skip_check 1 "forbidden-file-diff" "no local 'main' branch to diff against in this checkout"
fi

# ═══════════════════════════════════════════════════════════════════════════
# PHASE 2 — high-speed typechecking
# ═══════════════════════════════════════════════════════════════════════════

run_check 2 "tsc-forge-control" \
  "fix the type error at the location above, then re-run: cd forge-control && npx tsc --noEmit" \
  "cd forge-control && npx tsc --noEmit"

run_check 2 "tsc-forge-control-web" \
  "fix the type error at the location above, then re-run: cd forge-control-web && npx tsc --noEmit" \
  "cd forge-control-web && npx tsc --noEmit"

# scripts/checks/*.ts(x) itself is compiled by nothing else in the repo —
# check-instrument-typecheck.sh is the gate for it, and it already caches
# (content-hash of subject+profile bytes). Even fully cached it still costs
# ~50-60s on a loaded box (measured — see AI OS memory
# typecheck-fork-storm-under-contention), which is too slow for the "cheap
# enough nobody skips it" path. Deferred to --full on purpose, not dropped.
if [ "$MODE" = "full" ]; then
  run_check 2 "instrument-typecheck" \
    "see the full per-subject report: bash scripts/checks/check-instrument-typecheck.sh" \
    "bash scripts/checks/check-instrument-typecheck.sh"
else
  skip_check 2 "instrument-typecheck" "deferred to --full — check-instrument-typecheck.sh costs ~50-60s even fully cached under load; run 'guard.sh --full' before merging"
fi

# ═══════════════════════════════════════════════════════════════════════════
# PHASE 3 — web production build verification
# ═══════════════════════════════════════════════════════════════════════════

if [ "$MODE" = "full" ]; then
  run_check 3 "web-build" \
    "see the full log: cd forge-control-web && NODE_ENV=production pnpm build" \
    "cd forge-control-web && NODE_ENV=production pnpm build"
else
  skip_check 3 "web-build" "deferred to --full — a production build takes minutes; run 'guard.sh --full' before merging"
fi

# ═══════════════════════════════════════════════════════════════════════════
# PHASE 4 — the functional check suite
# ═══════════════════════════════════════════════════════════════════════════

# gates-808.sh IS "the key functional check scripts in scripts/checks/" —
# it is the repo's own committed, always-run-everything aggregation of them
# (see its header). Re-listing its gates here by hand would be exactly the
# hand-assembled, silently-shrinking gate set its own header exists to
# prevent (AI OS memory gates-808-is-the-repo-suite). Delegating means a
# gate added to gates-808.sh tomorrow is covered by guard.sh --full
# tomorrow, with no second file to remember to update. The reruns of
# tsc/build it does internally are accepted cost of --full, which is
# already the "minutes, not seconds, run before an actual merge" tier.
if [ "$MODE" = "full" ]; then
  run_check 4 "gates-808-suite" \
    "see the full per-gate report: bash scripts/checks/gates-808.sh --strict" \
    "bash scripts/checks/gates-808.sh --strict"
else
  skip_check 4 "gates-808-suite" "deferred to --full — the full functional-check suite (gates-808.sh --strict); run 'guard.sh --full' before merging"
fi

# ═══════════════════════════════════════════════════════════════════════════
# VERDICT
# ═══════════════════════════════════════════════════════════════════════════

PASS_COUNT=0; FAIL_COUNT=0; SKIP_COUNT=0
for s in "${STATUSES[@]}"; do
  case "$s" in
    PASS) PASS_COUNT=$((PASS_COUNT + 1)) ;;
    FAIL) FAIL_COUNT=$((FAIL_COUNT + 1)) ;;
    SKIP) SKIP_COUNT=$((SKIP_COUNT + 1)) ;;
  esac
done

EXIT_CODE=0
[ "$FAIL_COUNT" -gt 0 ] && EXIT_CODE=1
[ "$STRICT" -eq 1 ] && [ "$SKIP_COUNT" -gt 0 ] && EXIT_CODE=1

# Checked-output ($out in run_check) can carry raw \r bytes — pnpm's build
# spinner and npm's progress line both emit them — plus other control chars
# a plain \n-only escaper leaves unescaped, which is invalid inside a JSON
# string (RFC 8259 requires every U+0000-U+001F escaped). Measured: guard.sh
# --full --json used to fail `jq`/`json.loads` on exactly this. jq -Rs .
# already returns a fully-quoted, fully-escaped JSON string, so callers stop
# wrapping its output in literal quotes.
json_escape() {
  printf '%s' "$1" | jq -Rs .
}

if [ "$JSON_OUT" -eq 1 ]; then
  n=${#NAMES[@]}
  printf '{\n  "mode": "%s",\n  "strict": %s,\n  "generated_at": "%s",\n  "checks": [\n' \
    "$MODE" "$([ "$STRICT" -eq 1 ] && echo true || echo false)" "$(date -Is)"
  for i in "${!NAMES[@]}"; do
    comma=","
    [ "$i" -eq $((n - 1)) ] && comma=""
    printf '    {"phase": %s, "name": %s, "status": "%s", "duration_s": %s, "detail": %s, "fix": %s, "raw": %s}%s\n' \
      "${PHASES[$i]}" "$(json_escape "${NAMES[$i]}")" "${STATUSES[$i]}" "${DURATIONS[$i]}" \
      "$(json_escape "${DETAILS[$i]}")" "$(json_escape "${FIXES[$i]}")" "$(json_escape "${RAWOUT[$i]:-}")" "$comma"
  done
  printf '  ],\n  "summary": {"pass": %d, "fail": %d, "skip": %d},\n  "exit_code": %d\n}\n' \
    "$PASS_COUNT" "$FAIL_COUNT" "$SKIP_COUNT" "$EXIT_CODE"
  exit $EXIT_CODE
fi

echo
echo "================================================================================"
printf " GUARD — mode=%s strict=%s   %s\n" "$MODE" "$([ "$STRICT" -eq 1 ] && echo on || echo off)" "$(date -Is)"
echo "================================================================================"
echo
printf '%-2s %-24s %-6s %6s   %s\n' "PH" "CHECK" "STATUS" "TIME" "DETAIL"
printf '%-2s %-24s %-6s %6s   %s\n' "--" "------------------------" "------" "----" "------"
for i in "${!NAMES[@]}"; do
  printf '%-2s %-24s %-6s %5ss   %s\n' \
    "${PHASES[$i]}" "${NAMES[$i]}" "${STATUSES[$i]}" "${DURATIONS[$i]}" "${DETAILS[$i]}"
done
echo
echo "PASS: $PASS_COUNT   FAIL: $FAIL_COUNT   SKIP: $SKIP_COUNT"

if [ "$FAIL_COUNT" -gt 0 ]; then
  echo
  echo "── FAILURES — what broke and how to fix it ──"
  for i in "${!NAMES[@]}"; do
    if [ "${STATUSES[$i]}" = "FAIL" ]; then
      printf '\n%s (phase %s)\n  at:  %s\n  fix: %s\n' \
        "${NAMES[$i]}" "${PHASES[$i]}" "${DETAILS[$i]}" "${FIXES[$i]}"
    fi
  done
fi

echo
if [ "$EXIT_CODE" -ne 0 ]; then
  echo "GUARD: RED — do not merge. Fix the failure(s) above and re-run."
else
  echo "GUARD: GREEN — safe to merge at mode=$MODE."
  if [ "$MODE" = "fast" ]; then
    echo "  note: --fast skips the production build, the scripts/checks instrument"
    echo "  typecheck, and the functional gate suite. Run 'guard.sh --full' before"
    echo "  the actual merge."
  fi
fi

exit $EXIT_CODE
